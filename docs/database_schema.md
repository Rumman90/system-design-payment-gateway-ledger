# Database Schema: Payment Gateway & Ledger

Complete PostgreSQL and CockroachDB table definitions.

---

## 1. Important Rules
* **No floating-point numbers:** Money is always stored as integers (`BIGINT`) in cents (e.g. `$10.50` is stored as `1050`). Using floats causes rounding errors.
* **UUID primary keys:** Prevents ID enumeration attacks and makes data easy to shard across regions.
* **Append-only ledger:** The `ledger_entries` table allows `INSERT` and `SELECT` only. `UPDATE` and `DELETE` permissions are blocked.

---

## 2. SQL Tables

### 2.1 `payment_orders`
Tracks the main state of a customer's purchase.

```sql
CREATE TYPE payment_status AS ENUM (
    'INITIATED',
    'PROCESSING',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'REFUNDED',
    'PARTIALLY_REFUNDED'
);

CREATE TABLE payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL, -- e.g. 'USD', 'EUR', 'GBP'
    status payment_status NOT NULL DEFAULT 'INITIATED',
    psp_provider VARCHAR(32) NOT NULL, -- e.g. 'STRIPE', 'ADYEN', 'VISA'
    psp_transaction_id VARCHAR(128),
    error_code VARCHAR(64),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_merchant_idempotency UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX idx_payment_orders_merchant_created ON payment_orders (merchant_id, created_at DESC);
CREATE INDEX idx_payment_orders_psp_tx ON payment_orders (psp_provider, psp_transaction_id);
```

---

### 2.2 `idempotency_records`
Persistent storage for idempotency keys if Redis restarts or evicts keys.

```sql
CREATE TABLE idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of original request
    http_status_code INT,
    response_body JSONB,
    status VARCHAR(32) NOT NULL, -- 'IN_PROGRESS', 'COMPLETED', 'FAILED'
    locked_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_idempotency_merchant_key UNIQUE (merchant_id, idempotency_key)
);
```

---

### 2.3 `ledger_accounts`
Defines every account in the chart of accounts.

```sql
CREATE TYPE account_type AS ENUM (
    'ASSET',
    'LIABILITY',
    'EQUITY',
    'REVENUE',
    'EXPENSE'
);

CREATE TABLE ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_code VARCHAR(128) NOT NULL UNIQUE, -- e.g., 'liability:merchant:merch_456:usd'
    currency VARCHAR(3) NOT NULL,
    account_type account_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### 2.4 `ledger_transactions` and `ledger_entries`
The double-entry journal.

```sql
CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    reference_id VARCHAR(128) NOT NULL, -- e.g. payment ID or refund ID
    transaction_type VARCHAR(64) NOT NULL, -- 'PAYMENT_CAPTURE', 'REFUND', 'PAYOUT'
    description TEXT,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE entry_direction AS ENUM ('DEBIT', 'CREDIT');

CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    direction entry_direction NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_entries_account_created ON ledger_entries (account_id, created_at DESC);
CREATE INDEX idx_ledger_entries_tx_id ON ledger_entries (transaction_id);
```

---

### 2.5 `outbox_events`
Stores messages waiting to be sent to Kafka.

```sql
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON outbox_events (status, created_at) WHERE status = 'PENDING';
```
