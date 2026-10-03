/**
 * Idempotent Payment Processor & Double-Entry Ledger Worker Example (Node.js)
 * ============================================================================
 * A reference implementation demonstrating:
 * 1. Idempotency Key validation with SHA-256 payload hashing
 * 2. Distributed locking semantics
 * 3. Payment execution state machine
 * 4. Atomic double-entry ledger posting (Debits == Credits)
 */

const crypto = require('crypto');

class MockRedis {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }

  get(key) {
    if (this.store.has(key)) {
      const expiry = this.ttls.get(key) || Infinity;
      if (Date.now() > expiry) {
        this.store.delete(key);
        this.ttls.delete(key);
        return null;
      }
      return this.store.get(key);
    }
    return null;
  }

  setNxEx(key, value, ttlSeconds) {
    const now = Date.now();
    if (this.store.has(key)) {
      const expiry = this.ttls.get(key) || Infinity;
      if (now <= expiry) {
        return false; // Key exists and lock is active
      }
    }
    this.store.set(key, value);
    this.ttls.set(key, now + ttlSeconds * 1000);
    return true;
  }

  set(key, value, ttlSeconds = 86400) {
    this.store.set(key, value);
    this.ttls.set(key, Date.now() + ttlSeconds * 1000);
  }
}

class DoubleEntryLedger {
  constructor() {
    this.accounts = {
      'asset:bank:stripe_clearing': 0,
      'liability:merchant:merch_456': 0,
      'revenue:platform_fees': 0,
    };
    this.journalEntries = [];
  }

  postTransaction(txId, entries) {
    // Step 1: Verify Zero-Sum Rule (Total Debits == Total Credits)
    const totalDebit = entries
      .filter((e) => e.direction === 'DEBIT')
      .reduce((sum, e) => sum + e.amount, 0);

    const totalCredit = entries
      .filter((e) => e.direction === 'CREDIT')
      .reduce((sum, e) => sum + e.amount, 0);

    if (totalDebit !== totalCredit) {
      throw new Error(
        `Ledger Invariant Broken! Debits (${totalDebit}) != Credits (${totalCredit})`
      );
    }

    // Step 2: Apply to Accounts
    for (const entry of entries) {
      const { account, direction, amount } = entry;
      if (!(account in this.accounts)) {
        this.accounts[account] = 0;
      }

      // For Asset: Debit increases (+), Credit decreases (-)
      // For Liability/Revenue: Credit increases (+), Debit decreases (-)
      let delta = 0;
      if (account.startsWith('asset:')) {
        delta = direction === 'DEBIT' ? amount : -amount;
      } else {
        delta = direction === 'CREDIT' ? amount : -amount;
      }

      this.accounts[account] += delta;
    }

    this.journalEntries.push({
      txId,
      entries,
      postedAt: new Date().toISOString(),
    });

    return true;
  }
}

class PaymentService {
  constructor(redis, ledger) {
    this.redis = redis;
    this.ledger = ledger;
  }

  computeHash(payload) {
    // Sort object keys alphabetically for consistent deterministic hashing
    const sorted = Object.keys(payload)
      .sort()
      .reduce((acc, key) => {
        acc[key] = payload[key];
        return acc;
      }, {});

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(sorted))
      .digest('hex');
  }

  charge(merchantId, idempotencyKey, requestPayload) {
    const redisKey = `idempotency:${merchantId}:${idempotencyKey}`;
    const requestHash = this.computeHash(requestPayload);

    // 1. Check if Idempotency Key exists
    const existingVal = this.redis.get(redisKey);
    if (existingVal) {
      const data = JSON.parse(existingVal);
      if (data.requestHash !== requestHash) {
        return {
          statusCode: 422,
          body: {
            error: 'idempotency_payload_mismatch',
            message: 'Payload does not match the initial request for this key.',
          },
        };
      }
      if (data.status === 'IN_PROGRESS') {
        return {
          statusCode: 409,
          body: {
            error: 'concurrent_request_in_progress',
            message: 'Payment is currently processing. Please wait.',
          },
        };
      }
      if (data.status === 'COMPLETED') {
        // Return cached response
        return {
          statusCode: data.statusCode,
          body: data.responseBody,
        };
      }
    }

    // 2. Acquire In-Flight Lock (TTL: 60s)
    const lockPayload = JSON.stringify({
      status: 'IN_PROGRESS',
      requestHash,
    });

    if (!this.redis.setNxEx(redisKey, lockPayload, 60)) {
      return {
        statusCode: 409,
        body: {
          error: 'concurrent_request_in_progress',
          message: 'Concurrent request detected.',
        },
      };
    }

    try {
      // 3. Process Payment (Simulated Bank / Card Network Call)
      const paymentId = `pay_${crypto.randomBytes(6).toString('hex')}`;
      const amount = requestPayload.amount; // in cents e.g., 10000 ($100.00)
      const feeAmount = Math.floor(amount * 0.03); // 3% fee ($3.00)
      const merchantAmount = amount - feeAmount; // $97.00

      // 4. Atomic Double-Entry Ledger Posting
      const ledgerEntries = [
        {
          account: 'asset:bank:stripe_clearing',
          direction: 'DEBIT',
          amount: amount,
        },
        {
          account: `liability:merchant:${merchantId}`,
          direction: 'CREDIT',
          amount: merchantAmount,
        },
        {
          account: 'revenue:platform_fees',
          direction: 'CREDIT',
          amount: feeAmount,
        },
      ];

      this.ledger.postTransaction(paymentId, ledgerEntries);

      const responseBody = {
        id: paymentId,
        amount: amount,
        currency: requestPayload.currency || 'USD',
        status: 'CAPTURED',
        fee_amount: feeAmount,
        net_amount: merchantAmount,
      };

      // 5. Save Final Idempotent Result (TTL: 24 hours)
      const completedPayload = JSON.stringify({
        status: 'COMPLETED',
        requestHash,
        statusCode: 200,
        responseBody,
      });

      this.redis.set(redisKey, completedPayload, 86400);

      return {
        statusCode: 200,
        body: responseBody,
      };
    } catch (error) {
      return {
        statusCode: 500,
        body: {
          error: 'internal_error',
          message: error.message,
        },
      };
    }
  }
}

// --- Run Demonstration ---
if (require.main === module) {
  const redis = new MockRedis();
  const ledger = new DoubleEntryLedger();
  const service = new PaymentService(redis, ledger);

  const req = {
    amount: 10000,
    currency: 'USD',
    card_token: 'tok_visa_4242',
  };
  const idemKey = 'test_key_12345';

  console.log('--- 1. First Request (Initial Execution) ---');
  const res1 = service.charge('merch_456', idemKey, req);
  console.log(`Status: ${res1.statusCode}`);
  console.log('Response:', JSON.stringify(res1.body, null, 2));

  console.log('\n--- 2. Duplicate Request (Same Key & Payload) ---');
  const res2 = service.charge('merch_456', idemKey, req);
  console.log(`Status: ${res2.statusCode} (Cached Identical Response)`);
  console.log('Response:', JSON.stringify(res2.body, null, 2));

  console.log('\n--- 3. Tampered Request (Same Key, Modified Amount) ---');
  const res3 = service.charge('merch_456', idemKey, {
    amount: 50000,
    currency: 'USD',
  });
  console.log(`Status: ${res3.statusCode}`);
  console.log('Response:', JSON.stringify(res3.body, null, 2));

  console.log('\n--- 4. Ledger Account Balances ---');
  console.log(JSON.stringify(ledger.accounts, null, 2));
}

module.exports = {
  MockRedis,
  DoubleEntryLedger,
  PaymentService,
};
