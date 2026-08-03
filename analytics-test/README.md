# FusionPBX analytics test data

This directory creates an isolated PostgreSQL database named
`fusionpbx_analytics_test`. It does not write to the FusionPBX production
database or `v_xml_cdr`.

## Create or rebuild the dataset

```bash
sudo -u postgres psql -f analytics-test/create_database.sql
sudo -u postgres psql -d fusionpbx_analytics_test -f analytics-test/seed.sql
```

The seed is repeatable and replaces only rows inside the test database. It
creates 365 days including today; today's synthetic calls stop at the current
time so future hours remain empty.

## Useful checks

```bash
sudo -u postgres psql -d fusionpbx_analytics_test -c \
  "select * from analytics_test.dataset_summary;"

sudo -u postgres psql -d fusionpbx_analytics_test -c \
  "select * from analytics_test.calls_monthly order by period;"
```

The principal source table is `analytics_test.call_records`. Ready-to-use
views are provided for hourly, daily and monthly charts.
