-- Audited administrator recovery of blocked profile-photo lifecycle records.

ALTER TABLE data_access_log
  DROP CONSTRAINT data_access_log_action_check;

ALTER TABLE data_access_log
  ADD CONSTRAINT data_access_log_action_check CHECK (action IN (
    'view_profile',
    'view_messages',
    'view_matches',
    'export_data',
    'admin_ban',
    'admin_unban',
    'admin_review_report',
    'admin_review_dsr',
    'admin_reconcile_photo',
    'system_anonymize',
    'system_export_portability'
  ));
