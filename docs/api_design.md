# API Design: Payment Gateway & Webhooks

Clean, simple REST endpoints and webhook definitions modeled after industry standards like Stripe and Adyen.

---

## 1. Authentication & Security
* Every request includes a secret API key: `Authorization: Bearer sec_live_987abc...`
* All payment calls require an `Idempotency-Key` header with a client-generated UUID.
* Webhook requests sent to merchants are signed with an HMAC-SHA256 header: `X-Signature-SHA256: t=1759485600,v1=9a8b...`

---

## 2. Main Endpoints

### 2.1 Charge a Customer
`POST /v1/payments/charge`

#### Headers
```http
POST /v1/payments/charge HTTP/1.1
Host: api.payments.internal
Authorization: Bearer sec_live_merchant_123
Idempotency-Key: 7b6e92b3-9c8e-4a6f-b1e8-782a938c5b2a
Content-Type: application/json
```

#### Request
```json
{
  "amount": 10000,
  "currency": "USD",
  "payment_method": {
    "type": "card_token",
    "token": "tok_visa_4242_test"
  },
  "customer_id": "cust_usr_9988",
  "capture": true
}
```

#### Response (200 OK)
```json
{
  "id": "pay_987654321",
  "object": "payment",
  "amount": 10000,
  "currency": "USD",
  "status": "CAPTURED",
  "payment_method": {
    "type": "card",
    "brand": "visa",
    "last4": "4242"
  },
  "fee_amount": 300,
  "net_amount": 9700,
  "created_at": "2026-10-03T10:00:00Z"
}
```

---

### 2.2 Issue a Refund
`POST /v1/payments/{payment_id}/refund`

#### Request
```json
{
  "amount": 5000,
  "reason": "customer_requested"
}
```

#### Response (200 OK)
```json
{
  "id": "ref_11223344",
  "object": "refund",
  "payment_id": "pay_987654321",
  "amount": 5000,
  "currency": "USD",
  "status": "SUCCEEDED",
  "created_at": "2026-10-03T10:05:00Z"
}
```

---

### 2.3 Check Account Balance
`GET /v1/ledger/accounts/{account_id}/balance`

#### Response (200 OK)
```json
{
  "account_id": "acc_merch_456",
  "currency": "USD",
  "available_balance": 485000,
  "pending_balance": 15000,
  "as_of_timestamp": "2026-10-03T10:05:30Z"
}
```

---

## 3. Webhook Delivery

When payment statuses change, our servers send a POST request to the merchant's webhook URL.

### Example Webhook Body
```json
{
  "id": "evt_0011223344",
  "event_type": "payment.succeeded",
  "created_at": 1759485600,
  "data": {
    "payment_id": "pay_987654321",
    "amount": 10000,
    "currency": "USD",
    "status": "CAPTURED",
    "merchant_id": "merch_123"
  }
}
```

### How Merchants Verify the Payload
To prevent attackers from sending fake webhooks, merchants check the signature using their webhook secret:
```text
Calculated Signature = HMAC-SHA256(webhook_secret, timestamp + "." + request_body)
```
If the timestamp is older than 5 minutes, the merchant should drop the message to protect against replay attacks.
