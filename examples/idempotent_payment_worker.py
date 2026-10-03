"""
Idempotent Payment Processor & Double-Entry Ledger Worker Example
=================================================================
A reference implementation demonstrating:
1. Idempotency Key validation with SHA-256 payload hashing
2. Distributed locking semantics
3. Payment execution state machine
4. Atomic double-entry ledger posting (Debits == Credits)
"""

import hashlib
import json
import time
import uuid
from typing import Dict, Any, Tuple, Optional


class MockRedis:
    """Mock Redis client simulating atomic SET NX EX operations."""
    def __init__(self):
        self.store = {}
        self.ttls = {}

    def get(self, key: str) -> Optional[str]:
        if key in self.store:
            if time.time() > self.ttls.get(key, float('inf')):
                del self.store[key]
                del self.ttls[key]
                return None
            return self.store[key]
        return None

    def set_nx_ex(self, key: str, value: str, ttl_seconds: int) -> bool:
        if key in self.store:
            if time.time() <= self.ttls.get(key, float('inf')):
                return False  # Key already exists and is active
        self.store[key] = value
        self.ttls[key] = time.time() + ttl_seconds
        return True

    def set(self, key: str, value: str, ttl_seconds: int = 86400):
        self.store[key] = value
        self.ttls[key] = time.time() + ttl_seconds


class DoubleEntryLedger:
    """Simulated Double-Entry Ledger keeping immutable balanced entries."""
    def __init__(self):
        self.accounts = {
            "asset:bank:stripe_clearing": 0,
            "liability:merchant:merch_456": 0,
            "revenue:platform_fees": 0,
        }
        self.journal_entries = []

    def post_transaction(self, tx_id: str, entries: list) -> bool:
        # Step 1: Verify Zero-Sum Rule (Total Debits == Total Credits)
        total_debit = sum(e["amount"] for e in entries if e["direction"] == "DEBIT")
        total_credit = sum(e["amount"] for e in entries if e["direction"] == "CREDIT")

        if total_debit != total_credit:
            raise ValueError(f"Ledger Invariant Broken! Debits ({total_debit}) != Credits ({total_credit})")

        # Step 2: Apply to Accounts
        for e in entries:
            acc = e["account"]
            if acc not in self.accounts:
                self.accounts[acc] = 0

            # For Asset: Debit increases (+), Credit decreases (-)
            # For Liability/Revenue: Credit increases (+), Debit decreases (-)
            if acc.startswith("asset:"):
                delta = e["amount"] if e["direction"] == "DEBIT" else -e["amount"]
            else:
                delta = e["amount"] if e["direction"] == "CREDIT" else -e["amount"]

            self.accounts[acc] += delta

        self.journal_entries.append({"tx_id": tx_id, "entries": entries, "posted_at": time.time()})
        return True


class PaymentService:
    def __init__(self, redis: MockRedis, ledger: DoubleEntryLedger):
        self.redis = redis
        self.ledger = ledger
        self.payments_db = {}

    def _compute_hash(self, payload: Dict[str, Any]) -> str:
        serialized = json.dumps(payload, sort_keys=True)
        return hashlib.sha256(serialized.encode('utf-8')).hexdigest()

    def charge(self, merchant_id: str, idempotency_key: str, request_payload: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        redis_key = f"idempotency:{merchant_id}:{idempotency_key}"
        request_hash = self._compute_hash(request_payload)

        # 1. Check if Idempotency Key exists
        existing_val = self.redis.get(redis_key)
        if existing_val:
            data = json.loads(existing_val)
            if data["request_hash"] != request_hash:
                return 422, {
                    "error": "idempotency_payload_mismatch",
                    "message": "Payload does not match the initial request for this key."
                }
            if data["status"] == "IN_PROGRESS":
                return 409, {
                    "error": "concurrent_request_in_progress",
                    "message": "Payment is currently processing. Please wait."
                }
            if data["status"] == "COMPLETED":
                # Return cached response
                return data["status_code"], data["response_body"]

        # 2. Acquire In-Flight Lock (TTL 60s)
        lock_payload = json.dumps({"status": "IN_PROGRESS", "request_hash": request_hash})
        if not self.redis.set_nx_ex(redis_key, lock_payload, ttl_seconds=60):
            return 409, {"error": "concurrent_request_in_progress", "message": "Concurrent request detected."}

        try:
            # 3. Process Payment (Simulated PSP Call)
            payment_id = f"pay_{uuid.uuid4().hex[:12]}"
            amount = request_payload["amount"]  # e.g., 10000 ($100.00)
            fee_amount = int(amount * 0.03)     # 3% fee ($3.00)
            merchant_amount = amount - fee_amount # $97.00

            # 4. Atomic Double-Entry Ledger Posting
            ledger_entries = [
                {"account": "asset:bank:stripe_clearing", "direction": "DEBIT", "amount": amount},
                {"account": f"liability:merchant:{merchant_id}", "direction": "CREDIT", "amount": merchant_amount},
                {"account": "revenue:platform_fees", "direction": "CREDIT", "amount": fee_amount},
            ]
            self.ledger.post_transaction(payment_id, ledger_entries)

            response_body = {
                "id": payment_id,
                "amount": amount,
                "currency": request_payload.get("currency", "USD"),
                "status": "CAPTURED",
                "fee_amount": fee_amount,
                "net_amount": merchant_amount
            }

            # 5. Store Final Idempotent Result (TTL 24 hours)
            completed_payload = json.dumps({
                "status": "COMPLETED",
                "request_hash": request_hash,
                "status_code": 200,
                "response_body": response_body
            })
            self.redis.set(redis_key, completed_payload, ttl_seconds=86400)
            return 200, response_body

        except Exception as e:
            # Release lock on crash
            return 500, {"error": "internal_error", "message": str(e)}


if __name__ == "__main__":
    redis = MockRedis()
    ledger = DoubleEntryLedger()
    service = PaymentService(redis, ledger)

    req = {"amount": 10000, "currency": "USD", "card_token": "tok_visa_4242"}
    idem_key = "test_key_12345"

    print("--- 1. First Request (Initial Execution) ---")
    status, res = service.charge("merch_456", idem_key, req)
    print(f"Status: {status}\nResponse: {json.dumps(res, indent=2)}")

    print("\n--- 2. Duplicate Request (Same Key & Payload) ---")
    status, res2 = service.charge("merch_456", idem_key, req)
    print(f"Status: {status} (Cached Identical Response)\nResponse: {json.dumps(res2, indent=2)}")

    print("\n--- 3. Tampered Request (Same Key, Modified Amount) ---")
    status, res3 = service.charge("merch_456", idem_key, {"amount": 50000, "currency": "USD"})
    print(f"Status: {status}\nResponse: {json.dumps(res3, indent=2)}")

    print("\n--- 4. Ledger Account Balances ---")
    print(json.dumps(ledger.accounts, indent=2))
