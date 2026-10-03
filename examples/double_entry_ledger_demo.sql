-- Double-Entry Ledger Posting Function with Invariant Enforcement
-- Target: PostgreSQL 14+ / CockroachDB

-- Step 1: Create atomic posting function
CREATE OR REPLACE FUNCTION post_ledger_transaction(
    p_idempotency_key VARCHAR(128),
    p_reference_id VARCHAR(128),
    p_transaction_type VARCHAR(64),
    p_description TEXT,
    p_entries JSONB -- Array of { "account_code": "...", "direction": "DEBIT"|"CREDIT", "amount": 10000 }
) RETURNS UUID AS $$
DECLARE
    v_tx_id UUID;
    v_total_debit BIGINT := 0;
    v_total_credit BIGINT := 0;
    v_entry JSONB;
    v_account_id UUID;
    v_amount BIGINT;
    v_direction VARCHAR(10);
BEGIN
    -- 1. Validate Zero-Sum Invariant (Debits == Credits)
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_amount := (v_entry->>'amount')::BIGINT;
        v_direction := v_entry->>'direction';

        IF v_amount <= 0 THEN
            RAISE EXCEPTION 'Entry amount must be positive. Found: %', v_amount;
        END IF;

        IF v_direction = 'DEBIT' THEN
            v_total_debit := v_total_debit + v_amount;
        ELSIF v_direction = 'CREDIT' THEN
            v_total_credit := v_total_credit + v_amount;
        ELSE
            RAISE EXCEPTION 'Invalid direction: %. Must be DEBIT or CREDIT.', v_direction;
        END IF;
    END LOOP;

    IF v_total_debit <> v_total_credit THEN
        RAISE EXCEPTION 'Ledger transaction is unbalanced! Total Debits (%) != Total Credits (%)', 
            v_total_debit, v_total_credit;
    END IF;

    -- 2. Insert Parent Ledger Transaction Header
    INSERT INTO ledger_transactions (idempotency_key, reference_id, transaction_type, description)
    VALUES (p_idempotency_key, p_reference_id, p_transaction_type, p_description)
    RETURNING id INTO v_tx_id;

    -- 3. Insert Child Ledger Entries
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        -- Look up Account ID by code
        SELECT id INTO v_account_id 
        FROM ledger_accounts 
        WHERE account_code = (v_entry->>'account_code');

        IF v_account_id IS NULL THEN
            RAISE EXCEPTION 'Ledger account not found for code: %', (v_entry->>'account_code');
        END IF;

        INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
        VALUES (
            v_tx_id, 
            v_account_id, 
            (v_entry->>'direction')::entry_direction, 
            (v_entry->>'amount')::BIGINT
        );
    END LOOP;

    RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql;
