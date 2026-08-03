\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS analytics_test;

CREATE TABLE IF NOT EXISTS analytics_test.call_records (
  id bigserial PRIMARY KEY,
  call_uuid uuid NOT NULL DEFAULT gen_random_uuid(),
  domain_uuid uuid NOT NULL,
  extension text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'local')),
  caller_id_name text,
  caller_id_number text NOT NULL,
  destination_number text NOT NULL,
  start_stamp timestamptz NOT NULL,
  answer_stamp timestamptz,
  end_stamp timestamptz NOT NULL,
  duration integer NOT NULL CHECK (duration >= 0),
  billsec integer NOT NULL CHECK (billsec >= 0),
  wait_seconds integer NOT NULL CHECK (wait_seconds >= 0),
  missed_call boolean NOT NULL,
  status text NOT NULL CHECK (
    status IN ('answered', 'missed', 'busy', 'cancelled', 'failed')
  ),
  hangup_cause text NOT NULL,
  mos numeric(4,2),
  gateway text,
  call_center_queue text,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_stamp >= start_stamp),
  CHECK (
    (status = 'answered' AND answer_stamp IS NOT NULL AND billsec > 0)
    OR
    (status <> 'answered' AND answer_stamp IS NULL AND billsec = 0)
  )
);

CREATE INDEX IF NOT EXISTS call_records_start_stamp_idx
  ON analytics_test.call_records (start_stamp);
CREATE INDEX IF NOT EXISTS call_records_domain_start_idx
  ON analytics_test.call_records (domain_uuid, start_stamp);
CREATE INDEX IF NOT EXISTS call_records_extension_start_idx
  ON analytics_test.call_records (extension, start_stamp);
CREATE INDEX IF NOT EXISTS call_records_status_start_idx
  ON analytics_test.call_records (status, start_stamp);

TRUNCATE analytics_test.call_records RESTART IDENTITY;
SELECT setseed(0.260802);

-- Build 365 days including today. Today's calls stop at the current time so
-- future hourly buckets remain empty. Weekdays carry more traffic; calls
-- cluster in business hours.
WITH days AS MATERIALIZED (
  SELECT day::date AS call_date
  FROM generate_series(
    (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 364,
    (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
    interval '1 day'
  ) AS day
),
daily_load AS MATERIALIZED (
  SELECT
    call_date,
    CASE
      WHEN extract(isodow FROM call_date) BETWEEN 1 AND 5
        THEN 170 + floor(random() * 111)::int
      ELSE 55 + floor(random() * 56)::int
    END
    * CASE
        -- Planned incidents/campaigns make spikes and troughs visible in charts.
        WHEN call_date = current_date - 10 THEN 3.0
        WHEN call_date BETWEEN current_date - 95 AND current_date - 89 THEN 1.8
        WHEN call_date BETWEEN current_date - 190 AND current_date - 184 THEN 0.25
        ELSE 1.0
      END AS call_count
  FROM days
),
raw AS MATERIALIZED (
  SELECT
    dl.call_date,
    random() AS direction_roll,
    random() AS result_roll,
    random() AS extension_roll,
    random() AS minute_roll,
    random() AS duration_roll,
    random() AS wait_roll,
    random() AS mos_roll,
    random() AS gateway_roll,
    random() AS queue_roll
  FROM daily_load dl
  CROSS JOIN LATERAL generate_series(1, floor(dl.call_count)::int)
),
prepared AS MATERIALIZED (
  SELECT
    *,
    (ARRAY['1001','1002','1003','1004','1005','1006','1007','1008','1009','1010'])
      [1 + floor(extension_roll * 10)::int] AS extension,
    CASE
      WHEN direction_roll < 0.55 THEN 'inbound'
      WHEN direction_roll < 0.88 THEN 'outbound'
      ELSE 'local'
    END AS direction,
    CASE
      -- The incident 45 days ago deliberately has a high missed-call rate.
      WHEN call_date = current_date - 45 AND result_roll < 0.48 THEN 'missed'
      WHEN call_date = current_date - 45 AND result_roll < 0.78 THEN 'answered'
      WHEN result_roll < 0.74 THEN 'answered'
      WHEN result_roll < 0.86 THEN 'missed'
      WHEN result_roll < 0.92 THEN 'busy'
      WHEN result_roll < 0.97 THEN 'cancelled'
      ELSE 'failed'
    END AS status,
    -- 70% during 08:00-18:00, with the remainder spread across the day.
    (call_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      + CASE
          WHEN minute_roll < 0.70
            THEN interval '8 hours' + (minute_roll / 0.70) * interval '10 hours'
          ELSE ((minute_roll - 0.70) / 0.30) * interval '24 hours'
        END AS start_stamp,
    3 + floor(wait_roll * 43)::int AS wait_seconds,
    20 + floor(duration_roll * duration_roll * 1180)::int AS talking_seconds,
    '09' || lpad(floor(random() * 100000000)::bigint::text, 8, '0') AS external_number,
    (ARRAY['gateway-viettel','gateway-vnpt','gateway-fpt'])
      [1 + floor(gateway_roll * 3)::int] AS gateway,
    (ARRAY['sales','support','customer-service'])
      [1 + floor(queue_roll * 3)::int] AS call_center_queue
  FROM raw
),
final_rows AS (
  SELECT
    *,
    CASE
      WHEN status = 'answered' THEN talking_seconds
      ELSE 0
    END AS billsec
  FROM prepared
)
INSERT INTO analytics_test.call_records (
  call_uuid, domain_uuid, extension, direction, caller_id_name,
  caller_id_number, destination_number, start_stamp, answer_stamp, end_stamp,
  duration, billsec, wait_seconds, missed_call, status, hangup_cause, mos,
  gateway, call_center_queue
)
SELECT
  gen_random_uuid(),
  '11111111-1111-4111-8111-111111111111'::uuid,
  extension,
  direction,
  CASE direction
    WHEN 'inbound' THEN 'Synthetic Customer'
    ELSE 'Extension ' || extension
  END,
  CASE WHEN direction = 'inbound' THEN external_number ELSE extension END,
  CASE WHEN direction = 'inbound' THEN extension ELSE external_number END,
  start_stamp,
  CASE
    WHEN status = 'answered' THEN start_stamp + wait_seconds * interval '1 second'
  END,
  start_stamp + (wait_seconds + billsec) * interval '1 second',
  wait_seconds + billsec,
  billsec,
  wait_seconds,
  status = 'missed',
  status,
  CASE status
    WHEN 'answered' THEN 'NORMAL_CLEARING'
    WHEN 'missed' THEN 'NO_ANSWER'
    WHEN 'busy' THEN 'USER_BUSY'
    WHEN 'cancelled' THEN 'ORIGINATOR_CANCEL'
    ELSE 'NORMAL_TEMPORARY_FAILURE'
  END,
  CASE
    WHEN status = 'answered' THEN
      round(greatest(1.5, least(4.5,
        2.8 + mos_roll * 1.7
        - CASE WHEN gateway = 'gateway-fpt' AND call_date BETWEEN current_date - 70 AND current_date - 64
            THEN 1.1 ELSE 0 END
      ))::numeric, 2)
  END,
  gateway,
  call_center_queue
FROM final_rows
WHERE start_stamp <= now();

CREATE OR REPLACE VIEW analytics_test.calls_hourly AS
SELECT
  domain_uuid,
  date_trunc('hour', start_stamp) AS period,
  count(*) AS total_calls,
  count(*) FILTER (WHERE status = 'answered') AS answered,
  count(*) FILTER (WHERE missed_call) AS missed,
  sum(billsec) AS bill_seconds,
  round(avg(billsec) FILTER (WHERE status = 'answered'), 2) AS aloc_seconds,
  round(100.0 * count(*) FILTER (WHERE status = 'answered') / nullif(count(*), 0), 2) AS asr,
  round(avg(mos), 2) AS average_mos
FROM analytics_test.call_records
GROUP BY domain_uuid, date_trunc('hour', start_stamp);

CREATE OR REPLACE VIEW analytics_test.calls_daily AS
SELECT
  domain_uuid,
  date_trunc('day', start_stamp) AS period,
  count(*) AS total_calls,
  count(*) FILTER (WHERE direction = 'inbound') AS inbound,
  count(*) FILTER (WHERE direction = 'outbound') AS outbound,
  count(*) FILTER (WHERE direction = 'local') AS local,
  count(*) FILTER (WHERE status = 'answered') AS answered,
  count(*) FILTER (WHERE missed_call) AS missed,
  sum(billsec) AS bill_seconds,
  round(avg(billsec) FILTER (WHERE status = 'answered'), 2) AS aloc_seconds,
  round(100.0 * count(*) FILTER (WHERE status = 'answered') / nullif(count(*), 0), 2) AS asr,
  round(avg(mos), 2) AS average_mos
FROM analytics_test.call_records
GROUP BY domain_uuid, date_trunc('day', start_stamp);

CREATE OR REPLACE VIEW analytics_test.calls_monthly AS
SELECT
  domain_uuid,
  date_trunc('month', start_stamp) AS period,
  count(*) AS total_calls,
  count(*) FILTER (WHERE status = 'answered') AS answered,
  count(*) FILTER (WHERE missed_call) AS missed,
  sum(billsec) AS bill_seconds,
  round(avg(billsec) FILTER (WHERE status = 'answered'), 2) AS aloc_seconds,
  round(100.0 * count(*) FILTER (WHERE status = 'answered') / nullif(count(*), 0), 2) AS asr,
  round(avg(mos), 2) AS average_mos
FROM analytics_test.call_records
GROUP BY domain_uuid, date_trunc('month', start_stamp);

CREATE OR REPLACE VIEW analytics_test.dataset_summary AS
SELECT
  count(*) AS total_calls,
  min(start_stamp) AS first_call,
  max(start_stamp) AS last_call,
  count(DISTINCT date_trunc('day', start_stamp)) AS populated_days,
  count(*) FILTER (WHERE status = 'answered') AS answered,
  count(*) FILTER (WHERE missed_call) AS missed,
  round(100.0 * count(*) FILTER (WHERE status = 'answered') / nullif(count(*), 0), 2) AS asr,
  round(avg(mos), 2) AS average_mos
FROM analytics_test.call_records;

ANALYZE analytics_test.call_records;

TABLE analytics_test.dataset_summary;
