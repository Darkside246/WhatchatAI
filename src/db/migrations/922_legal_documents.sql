-- Legal document registry: versioned T&C and Privacy Policy stored in the DB
-- so operators can update content without a code deployment.

CREATE TABLE legal_documents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT        NOT NULL CHECK (document_type IN ('TERMS', 'PRIVACY')),
  version       TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  content_html  TEXT        NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active document per type at any time.
CREATE UNIQUE INDEX idx_legal_documents_active_type
  ON legal_documents (document_type)
  WHERE is_active = true;

CREATE INDEX idx_legal_documents_type_effective
  ON legal_documents (document_type, effective_at DESC);

-- Seed: insert initial Terms of Service.
INSERT INTO legal_documents (document_type, version, title, content_html, effective_at)
VALUES (
  'TERMS',
  '1.0',
  'Terms of Service',
  '<h2>1. Acceptance of Terms</h2>
<p>By accessing or using WhatsChat ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you may not use the Service.</p>

<h2>2. Description of Service</h2>
<p>WhatsChat is a WhatsApp-first business operations platform that provides AI-assisted customer communication, invoicing, work order management, and related tools for businesses ("Business Users"). WhatsChat is operated by WhatsChat Technologies Ltd.</p>

<h2>3. Eligibility</h2>
<p>You must be at least 18 years old and have the legal authority to bind the business you represent. By agreeing to these Terms, you represent and warrant that you meet these requirements.</p>

<h2>4. Account Registration</h2>
<p>You agree to provide accurate, current, and complete information when creating an account. You are responsible for maintaining the confidentiality of your credentials and for all activities under your account.</p>

<h2>5. Acceptable Use</h2>
<p>You agree not to use the Service to: (a) violate any applicable law or regulation; (b) send spam or unsolicited communications; (c) transmit harmful, fraudulent, or deceptive content; (d) infringe intellectual property rights; (e) interfere with the Service's operation or security.</p>

<h2>6. WhatsApp Compliance</h2>
<p>You acknowledge that the Service integrates with WhatsApp and that your use must comply with WhatsApp''s Terms of Service and Business Policy. You are solely responsible for ensuring your communications comply with WhatsApp''s policies.</p>

<h2>7. Data and Privacy</h2>
<p>Your use of the Service is also governed by our Privacy Policy, which is incorporated into these Terms by reference. By using the Service, you consent to the collection, use, and sharing of your information as described in the Privacy Policy.</p>

<h2>8. Payment and Billing</h2>
<p>Subscription fees are billed in advance. All payments are non-refundable except as required by law. We reserve the right to modify pricing with 30 days'' notice.</p>

<h2>9. Intellectual Property</h2>
<p>The Service and its content are owned by WhatsChat Technologies Ltd and are protected by intellectual property laws. You are granted a limited, non-exclusive, non-transferable licence to use the Service for its intended purpose.</p>

<h2>10. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, WhatsChat shall not be liable for any indirect, incidental, special, consequential, or punitive damages. Our total liability shall not exceed the fees paid by you in the 12 months preceding the claim.</p>

<h2>11. Termination</h2>
<p>Either party may terminate this agreement at any time. We may suspend or terminate your access immediately for a material breach of these Terms.</p>

<h2>12. Governing Law</h2>
<p>These Terms are governed by the laws of Barbados. Any disputes shall be subject to the exclusive jurisdiction of the courts of Barbados.</p>

<h2>13. Changes to Terms</h2>
<p>We may update these Terms from time to time. We will notify you of material changes by email or in-app notice. Continued use of the Service after changes constitutes acceptance.</p>

<h2>14. Contact</h2>
<p>For questions about these Terms, contact us at <a href="mailto:legal@whatchat.ai">legal@whatchat.ai</a>.</p>',
  now()
);

-- Seed: insert initial Privacy Policy.
INSERT INTO legal_documents (document_type, version, title, content_html, effective_at)
VALUES (
  'PRIVACY',
  '1.0',
  'Privacy Policy',
  '<h2>1. Introduction</h2>
<p>WhatsChat Technologies Ltd ("we", "us", "our") is committed to protecting your personal data. This Privacy Policy explains how we collect, use, disclose, and protect your information when you use WhatsChat ("the Service").</p>
<p>This policy complies with the General Data Protection Regulation (GDPR), the Caribbean Community (CARICOM) data protection frameworks, and other applicable privacy laws.</p>

<h2>2. Data We Collect</h2>
<p><strong>Account data:</strong> Name, email address, phone number, and business information provided at registration.</p>
<p><strong>Usage data:</strong> Log data, device information, IP addresses, and feature usage patterns.</p>
<p><strong>Communication data:</strong> WhatsApp message metadata and content processed through the Service on your behalf.</p>
<p><strong>Consent data:</strong> Records of your agreement to our Terms and this Privacy Policy.</p>

<h2>3. Legal Basis for Processing (GDPR)</h2>
<p>We process your data on the following legal bases: (a) contract performance — to deliver the Service you subscribed to; (b) legitimate interests — to improve the Service and prevent fraud; (c) consent — for marketing communications, where you have explicitly opted in; (d) legal obligation — where required by law.</p>

<h2>4. How We Use Your Data</h2>
<p>We use your data to: provide and improve the Service; send transactional emails and account notices; send marketing communications (only where you have opted in); prevent fraud and abuse; comply with legal obligations.</p>

<h2>5. Marketing Communications</h2>
<p>If you have opted in to marketing communications, we may contact you with product updates, offers, and industry news. You may withdraw consent at any time by clicking "Unsubscribe" in any marketing email or contacting us at <a href="mailto:privacy@whatchat.ai">privacy@whatchat.ai</a>.</p>

<h2>6. Data Sharing</h2>
<p>We do not sell your personal data. We may share data with: trusted sub-processors (hosting, AI, email delivery) under data processing agreements; WhatsApp/Meta as required to operate the integration; law enforcement when legally required.</p>

<h2>7. Data Retention</h2>
<p>We retain your data for as long as your account is active and for up to 7 years thereafter for legal and audit purposes. Consent records are retained for 10 years to demonstrate compliance.</p>

<h2>8. Your Rights</h2>
<p>Under GDPR and applicable law, you have the right to: access your personal data; correct inaccurate data; request deletion ("right to be forgotten"); restrict or object to processing; data portability; withdraw consent at any time.</p>
<p>To exercise these rights, contact <a href="mailto:privacy@whatchat.ai">privacy@whatchat.ai</a>. We will respond within 30 days.</p>

<h2>9. Security</h2>
<p>We use AES-256-GCM encryption for sensitive data at rest, TLS for data in transit, and access controls to limit who can access your data.</p>

<h2>10. Cookies</h2>
<p>We use strictly necessary cookies to operate the Service and, with your consent, analytics cookies to understand usage. You may control cookie preferences through your browser settings.</p>

<h2>11. International Transfers</h2>
<p>Your data may be processed in countries outside your jurisdiction. We ensure appropriate safeguards (such as standard contractual clauses) are in place for any international transfers.</p>

<h2>12. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. We will notify you of material changes by email. The effective date at the top of this document indicates when the current version was last updated.</p>

<h2>13. Contact</h2>
<p>Data Controller: WhatsChat Technologies Ltd<br>
Email: <a href="mailto:privacy@whatchat.ai">privacy@whatchat.ai</a></p>',
  now()
);
