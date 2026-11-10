-- A sale can have one active or completed correction request at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_one_request_per_sale
ON correction_requests(ventas_device_id, sale_id)
WHERE status IN ('pending', 'approved', 'consumed');
