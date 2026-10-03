# System Design: Payment Gateway & Double-Entry Ledger System

A real-world breakdown of how payment systems like Stripe, PayPal, and Square process payments reliably. It explains how money moves safely between buyers, merchants, and banks without duplicate charges or lost funds.

---

## 1. Why Payment Systems are Hard

Building payments is totally different from building a chat app or a video platform. If a message drops or a video frame buffers for a second, nobody loses money. In payments, every cent matters.

Here are the real problems you run into:
* **The Internet Drops Mid-Payment:** A customer submits a payment, their Wi-Fi cuts out, and the browser hangs. Did the bank take the money or not? You can't just guess.
* **Double Clicks & Accidental Retries:** People get impatient and click "Pay" three times in a row, or mobile apps retry failed network calls in the background.
* **Partial Failures Across Services:** Deducting money from a balance, paying fees, and updating merchant balances are separate operations. If step 2 fails after step 1 succeeds, your numbers get messed up.
* **Auditing & Accounting Rules:** You can never just overwrite balances in a database column. Every movement of funds needs a permanent, unchangeable record.

---

## 2. Requirements

### What the System Must Do (Functional)
| Feature | What It Actually Does |
| :--- | :--- |
| **Process Charges** | Take card, wallet, and bank transfer payments from buyers. |
| **Stop Duplicate Charges** | Make sure retrying an API call or pressing a button twice never charges the customer twice. |
| **Keep a Balanced Ledger** | Record every transaction with double-entry accounting (Debits = Credits). |
| **Handle Refunds & Disputes** | Issue full or partial refunds and track chargebacks from banks. |
| **Daily Bank Reconciliation** | Compare internal database logs against bank statements every night to catch missing pennies. |
| **Notify Merchants (Webhooks)** | Send payment success/failure notifications to merchant servers. |

### How Reliable It Must Be (Non-Functional)
* **High Availability:** Checkout APIs should stay up 99.999% of the time.
* **Exact Balances (ACID):** Financial ledgers must always have strong consistency. Eventual consistency is not allowed here.
* **Speed:** Under 800ms for a full checkout request (most of this time is spent waiting on external card networks).
* **Zero Data Loss:** We cannot lose completed transactions, even if a whole data center loses power.
* **Security:** Card numbers are tokenized immediately. Plain card details never touch internal application servers.

---

## 3. Scale & Sizing Calculations

Let's do the math for a global platform handling **100 Million transactions a day**.

### 3.1 Requests per Second (TPS)
* **Daily volume:** 100,000,000 transactions / day
* **Average rate:**
  ```text
  100,000,000 / 86,400 seconds = 1,157 transactions / second (TPS)
  ```
* **Peak hours (5x normal load during sales):**
  ```text
  1,157 × 5 = 5,785 TPS
  ```
* **Read vs Write traffic:**
  * Writes (new payments, refunds, status changes) = ~5,800 TPS at peak.
  * Reads (merchants checking dashboard, status checks) = ~50,000 TPS at peak.

---

### 3.2 Storage Needed (5-Year Retention)
Financial laws usually require keeping records for at least 5 years.

Each transaction produces:
* 1 Payment order record (~1 KB)
* 1 Card network / PSP log (~2 KB)
* Double-entry ledger rows (~1 KB)
* Audit log & signatures (~1 KB)
* **Total size per transaction:** ~5 KB

```text
Daily Storage = 100,000,000 × 5 KB = 500 GB / day
1 Year Storage = 500 GB × 365 = 182.5 TB
5 Year Storage = 182.5 TB × 5 = 912.5 TB
```

---

## 4. System Architecture

```mermaid
flowchart TD
    Client["User / Merchant App"] -->|1. POST /v1/payments (Idempotency-Key)| APIGW["API Gateway"]
    
    APIGW -->|2. Route Request| PaySvc["Payment Service"]
    
    subgraph Fast Deduplication
        PaySvc -->|Acquire Lock| RedisLock["Redis (Locks & Idempotency Store)"]
    end
    
    subgraph Transaction Pipeline
        PaySvc -->|3. Save Initial Status| PayDB[("Payment DB (Postgres / CockroachDB)")]
        PaySvc -->|4. Forward Card Token| PSPProxy["Card Vault & PSP Proxy"]
        PSPProxy -->|5. Charge Card| ExtPSP["External Card Network (Visa, Stripe, Adyen)"]
        ExtPSP -->|6. Return Success / Decline| PSPProxy
        PSPProxy -->|7. Send Response| PaySvc
    end
    
    subgraph Event Queue
        PaySvc -->|8. Push Event| Kafka["Kafka Bus"]
        Kafka -->|Listen for Success| LedgerWorker["Ledger Service"]
        Kafka -->|Send Updates| WebhookWorker["Webhook Sender"]
    end

    subgraph Accounting
        LedgerWorker -->|9. Post Immutable Entries| LedgerDB[("Double-Entry Ledger DB")]
    end

    subgraph Daily Verification
        BankFile["Daily Bank Settlement Files (CSV / MT940)"] --> RecEngine["Reconciliation Engine"]
        LedgerDB --> RecEngine
        RecEngine -->|Find Mismatches| DisputeQueue["Manual Review Dashboard"]
    end
```

---

## 5. Key Architecture Decisions

### 1. Stopping Duplicate Charges with Idempotency Keys
Every payment request sends an `Idempotency-Key: <UUID>` header.
* When a request lands, we run an atomic check in Redis.
* If that key is already running, we reject the second call with a `409 Conflict`.
* Once finished, we save the final response against the key for 24 hours. If the merchant retries tomorrow, they get the exact same response without re-charging the customer.

### 2. Double-Entry Accounting
Never update balance fields directly. Every single financial event creates paired entries where:
```text
Total Debits = Total Credits
Assets = Liabilities + Equity
```
If a customer buys a $100 jacket:
* **Debit:** Our Bank Holding Account +$100 (Asset increases)
* **Credit:** Merchant's Wallet +$97 (Liability increases)
* **Credit:** Our Fee Account +$3 (Revenue increases)

The ledger table is strictly **insert-only**. You never run `UPDATE` or `DELETE` on financial entries.

### 3. Handling Network Drops (Saga Pattern)
When calling external banks, timeouts will happen. We treat the payment as an asynchronous workflow:
* If the bank endpoint hangs, we do not guess and we do not instantly refund.
* We mark the status as `PROCESSING_TIMEOUT` and kick off a background job to poll the bank until we get a clear YES or NO.

### 4. Midnight Bank Reconciliation
At midnight, banks send settlement files listing every charge they actually processed. Our matching engine compares three things:
```text
Internal Payment Orders <---> Ledger Records <---> Bank Settlement Files
```
If there is any difference (like an unexpected bank fee or a dropped transaction), it automatically flags it for the operations team.

---

## 6. Project Structure

```text
system-design-payment-gateway-ledger/
├── README.md                          # Main overview & system architecture
├── docs/
│   ├── architecture.md               # Step-by-step sequence diagrams and data flow
│   ├── idempotency_and_concurrency.md# Preventing double charges and race conditions
│   ├── double_entry_ledger.md        # How double-entry accounting works in databases
│   ├── distributed_transactions_saga.md # Sagas and transactional outbox patterns
│   ├── database_schema.md            # SQL table definitions and indexes
│   ├── api_design.md                 # REST endpoints and webhook payloads
│   ├── reconciliation_and_settlement.md # Daily bank matching algorithms
│   └── failure_scenarios.md          # Handling timeouts, outages, and retries
└── examples/
    ├── idempotent_payment_worker.py  # Working Python script demo
    ├── double_entry_ledger_demo.sql  # SQL function that prevents unbalanced entries
    └── sample_payment_flow.json      # Sample JSON requests and webhook payloads
```

---

## 7. Deep-Dive Links
* [Architecture & Step-by-Step Flow](docs/architecture.md)
* [Idempotency & Concurrency Guide](docs/idempotency_and_concurrency.md)
* [Double-Entry Ledger Fundamentals](docs/double_entry_ledger.md)
* [Sagas & Outbox Pattern](docs/distributed_transactions_saga.md)
* [Database Schemas & Tables](docs/database_schema.md)
* [REST APIs & Webhooks](docs/api_design.md)
* [Daily Reconciliation Engine](docs/reconciliation_and_settlement.md)
* [Failure Modes & Recovery](docs/failure_scenarios.md)

---

## 8. Code & Examples

* [Idempotent Payment Worker (Python)](examples/idempotent_payment_worker.py)
* [Double-Entry Ledger Posting Function (SQL)](examples/double_entry_ledger_demo.sql)
* [Sample Payment & Webhook Payloads (JSON)](examples/sample_payment_flow.json)

---

## License

This project is licensed under the [MIT License](LICENSE).


