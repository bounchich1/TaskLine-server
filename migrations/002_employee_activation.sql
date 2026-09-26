ALTER TABLE employees ADD COLUMN activated_at timestamptz;

UPDATE employees e SET activated_at = first_login.at
FROM (
  SELECT employee_id, min(at) AS at FROM (
    SELECT employee_id, issued_at AS at FROM staff_sessions
    UNION ALL
    SELECT actor_id, created_at FROM audit WHERE action = 'auth.login' AND actor_id IS NOT NULL
  ) logins GROUP BY employee_id
) first_login
WHERE first_login.employee_id = e.id;
