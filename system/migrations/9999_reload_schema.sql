-- 9999: runs last. Ask PostgREST to reload its schema cache so new tables,
-- columns and functions are reachable through the REST API at once.
notify pgrst, 'reload schema';
