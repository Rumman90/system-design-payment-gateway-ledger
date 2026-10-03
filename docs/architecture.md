# Architecture & Flow: Payment Gateway & Ledger System

This document explains how requests travel through our services when a customer buys something online, and how each component ensures money moves safely.

---

## 1. Step-by-Step Payment Flow

Here is what happens behind the scenes from the moment a user clicks "Pay" to the moment the merchant gets notified:

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer / Mobile App
    participant APIGW as API Gateway
    participant PaySvc as Payment Service
    participant Redis as Redis Lock & Cache
    participant PayDB as Payment Database
    participant PSP as External Bank / Visa / Stripe
    participant Kafka as Message Bus (Kafka)
    participant Ledger as Ledger Service
    participant LedgerDB as Ledger DB
    participant Webhook as Webhook Worker
    actor Merchant as Merchant Server

    Customer->>APIGW: POST /v1/payments/charge (Idempotency-Key, Card Token, $100)
    APIGW->>PaySvc: Validate Auth & Forward Request
    
    PaySvc->>Redis: Check and acquire lock for this Idempotency-Key
    alt Lock Failed (Duplicate or simultaneous click)
        Redis-->>PaySvc: Key already running or done
        PaySvc-->>Customer: Return 409 Conflict OR Cached Response
    else Lock Succeeded
        PaySvc->>PayDB: Insert payment record with status 'PENDING'
        
        PaySvc->>PSP: Send charge request to card network
        
        alt Bank Responded Successfully
            PSP-->>PaySvc: 200 OK (Transaction ID: ch_9876)
            PaySvc->>PayDB: Update payment status to 'SUCCESS'
            PaySvc->>Redis: Save finished response (valid for 24h)
            PaySvc->>Kafka: Emit PaymentCompleted event
            PaySvc-->>Customer: 200 OK (Payment Receipt)
        else Network Timed Out
            PSP-->>PaySvc: No answer after 5 seconds
            PaySvc->>PayDB: Mark status as 'PROCESSING_TIMEOUT'
            PaySvc->>Kafka: Emit CheckPaymentStatusLater event
            PaySvc-->>Customer: 202 Accepted (Payment is processing)
        end
    end

    par Write to Ledger
        Kafka->>Ledger: Pick up PaymentCompleted event
        Ledger->>LedgerDB: Insert balanced Debit and Credit rows
    and Send Webhook
        Kafka->>Webhook: Pick up PaymentCompleted event
        Webhook->>Merchant: POST https://merchant.com/webhook (Signed payload)
        Merchant-->>Webhook: 200 OK
    end
```

---

## 2. Main Components

### 2.1 API Gateway
* **Card Data Protection:** Customers send their card details to a separate browser/SDK form that swaps card numbers for safe tokens (like `tok_visa_4242`). The main gateway only ever touches these tokens, keeping sensitive 16-digit card numbers off our app servers.
* **Rate Limiting:** Protects internal databases from traffic spikes using token bucket rate limits for each merchant.

---

### 2.2 Payment Service
* Manages the lifecycle of a charge:
  ```text
  INITIATED -> PENDING -> AUTHORIZED -> CAPTURED -> SETTLED
                       -> FAILED
                       -> REFUNDED
  ```
* Coordinates with external card networks (Visa, Mastercard, Stripe, Adyen).

---

### 2.3 Redis Locks & Deduplication
* Prevents race conditions when two identical requests hit the server at the exact same millisecond.
* Holds a temporary lock while processing (TTL: 120 seconds).
* Saves the finished payment response for 24 to 72 hours so repeated calls get the same answer instantly.

---

### 2.4 Double-Entry Ledger Service
* Runs asynchronously by consuming Kafka events. That way, checkout latency does not wait on heavy accounting queries.
* Enforces the basic accounting rule:
  ```text
  Total Debits - Total Credits = 0
  ```
* Tables are insert-only. If an adjustment is needed, a compensating row is added instead of updating old rows.

---

### 2.5 Midnight Reconciliation Worker
* Downloads raw transaction logs from card networks and banks once a day.
* Compares bank logs against internal database records.
* Automatically flags any discrepancies (such as unexpected fees or missing funds) on a dashboard for the operations team.
