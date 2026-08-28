-- Expand product catalog with all UI verticals.
-- Existing keys (property, food, commerce, scheduling, support) are untouched.

INSERT INTO product_catalog (product_key, name, description) VALUES
  ('retail',        'WhatsChat Retail',       'Orders, inventory and customer commerce via WhatsApp.'),
  ('beauty',        'WhatsChat Beauty',       'Bookings, services and client management for salons and spas.'),
  ('auto',          'WhatsChat Auto',         'Job cards, estimates and customer communication for auto businesses.'),
  ('health',        'WhatsChat Health',       'Appointments, patient records and health communications.'),
  ('legal',         'WhatsChat Legal',        'Case enquiries, document requests and client intake for law practices.'),
  ('hospitality',   'WhatsChat Hospitality',  'Room bookings, guest services and housekeeping coordination.'),
  ('construction',  'WhatsChat Construction', 'Project tracking, subcontractors and materials management.'),
  ('logistics',     'WhatsChat Logistics',    'Delivery tracking, route management and customer notifications.')
ON CONFLICT (product_key) DO NOTHING;
