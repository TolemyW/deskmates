-- Issue #21: forced password changes apply to every password another person or the maintenance
-- CLI chose, not only the protected root's default password. Keep the reason beside the
-- credential so support can distinguish the two without storing who knew the password.
ALTER TABLE local_credentials ADD COLUMN password_change_reason TEXT
  CHECK (password_change_reason IN ('default', 'administrator'));

UPDATE local_credentials SET password_change_reason = 'default' WHERE must_change = 1;
