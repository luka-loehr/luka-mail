-- Urgency 1 means "matters within a week": the first live sweep (2026-10-23)
-- filed five AWS "DKIM setup FAILURE" alerts with it. Notifications are only
-- filed when nothing about them is time-bound. A rule the owner changed stays.
UPDATE autopilot_rules SET max_urgency = 0, updated_at = CURRENT_TIMESTAMP
  WHERE id = 'default-notification' AND max_urgency = 1;
