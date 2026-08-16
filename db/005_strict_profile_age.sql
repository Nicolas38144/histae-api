-- Keep the database rule aligned with the API's calendar-date majority rule.

CREATE OR REPLACE FUNCTION fct_check_user_age()
RETURNS trigger AS $$
BEGIN
  IF NEW.birthdate > (CURRENT_DATE - INTERVAL '18 years')::date THEN
    RAISE EXCEPTION 'User must be at least 18 years old';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
