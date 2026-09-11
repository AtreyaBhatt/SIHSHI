/**
 * Per-fixture expectations for the redaction leak test.
 *
 * `mustNotAppear` greps the whole serialized payload, so it is only sound for a
 * value that occurs ONCE on the page. When the same string appears in a field
 * and again in prose — where a known gap lets it through — the grep cannot tell
 * which copy it found. Use `redactedFields` for those: it asserts the specific
 * node's sanitized value is a marker, which is what "this field was redacted"
 * actually means.
 *
 * `knownGaps` are values this build is expected to MISS. They are reported, not
 * failed — the point is that the recall holes are written down and visible
 * rather than discovered by a judge. If one closes, the run says so, which is
 * how a detector improvement gets noticed instead of silently changing numbers.
 */

export const FIXTURES = [
  {
    name: 'bank-login (Scenario A)',
    file: '../eval/fixtures/bank-login.html',
    mustNotAppear: [
      ['password', 'hunter2-not-real'],
      ['PAN', 'ABCDE1234F'],
      ['account number', '50100247716839'],
      ['IFSC', 'MERD0001234'],
      ['card (spaced)', '4539 1488 0343 6467'],
      ['card (bare)', '4539148803436467'],
      ['email', 'ada.lovelace@example.org'],
      ['phone', '98765 43210'],
      ['person name', 'Ada Lovelace'],
    ],
    mustAppear: [
      ['password label', 'NetBanking password'],
      ['submit button label', 'Sign in'],
      ['heading', 'Sign in to NetBanking'],
      ['field label', 'Registered mobile'],
    ],
    manifestTypes: ['password', 'pan', 'bank_account', 'ifsc', 'card_number', 'email', 'phone', 'person_name'],
    redactedFields: [
      ['password field', 'input#password'],
      ['PAN field', 'input#pan'],
      ['account number cell', 'dd#account-number'],
    ],
    knownGaps: [
      ['customer id in a labelled field', 'MB4470193',
        'no type in the PRD §4.3 taxonomy covers a service-specific account identifier'],
    ],
  },
  {
    name: 'kyc-form (Scenario C)',
    file: '../eval/fixtures/kyc-form.html',
    mustNotAppear: [
      ['aadhaar in a field', '2345 6789 0124'],
      ['aadhaar in a table', '3987 6543 2109'],
      ['date of birth', '14/03/1991'],
      ['refund account', '918020045512367'],
      ['IFSC', 'SMPK0000456'],
      ['email in a table', 'rohan.iyer@example.net'],
      ['phone in a field', '9845012345'],
    ],
    // "42 Nandidurga Road" also appears in the agent's prose note, where
    // address-in-prose is a known gap, so a whole-payload grep would conflate
    // the two copies. Check the field itself instead.
    redactedFields: [
      ['street address', 'input#street'],
      ['PIN code', 'input#pincode'],
      ['empty PAN field', 'input#pan'],
      ['empty OTP field', 'input#otp'],
      ['applicant name', 'input#applicant-name'],
    ],
    mustAppear: [
      ['form heading', 'Complete your KYC'],
      ['aadhaar label', 'Aadhaar number'],
      ['submit button label', 'Verify and submit'],
      ['table header', 'Bank account for refunds'],
      ['non-sensitive status', 'Awaiting verification'],
      ['prose kept around the redactions', 'Meter reading confirmed'],
    ],
    manifestTypes: ['aadhaar', 'pan', 'otp', 'bank_account', 'ifsc', 'email', 'phone', 'address', 'date_of_birth', 'person_name'],
    knownGaps: [
      ['person name in free prose', 'Rohan Iyer, was not carrying',
        'needs the local NER model (PRD §6.2.3 step 3), cut from this build'],
      ['postal address in free prose', 'Benson Town, Bengaluru',
        'same — regex cannot bound an address and DOM context is absent in prose'],
      ['customer reference', 'SU-2019-884210',
        'no type in the PRD §4.3 taxonomy covers a service-specific account identifier'],
    ],
  },
  {
    name: 'edge-cases (unlabelled fields, structural headings)',
    file: '../eval/fixtures/edge-cases.html',
    // An unlabelled input's accessible name used to fall through to its value,
    // so the raw name shipped as `label` while `value` was tokenised.
    mustNotAppear: [
      ['unlabelled name', 'Ada Lovelace'],
      ['unlabelled account', '50100247716839'],
      ['unlabelled street', '42 Nandidurga Road'],
    ],
    // Headings and buttons that merely NAME a PII type are Tier 3 structure.
    mustAppear: [
      ['heading naming the OTP', 'Enter the OTP we sent'],
      ['heading naming Aadhaar', 'Aadhaar number'],
      ['button label', 'Resend OTP'],
      ['prose with a last-four', 'Your card ending 4242 is on file.'],
    ],
    manifestTypes: ['person_name', 'bank_account', 'address', 'otp', 'cvv'],
    redactedFields: [
      ['unlabelled name', 'input#unlabeled-name'],
      ['unlabelled account', 'input#unlabeled-acct'],
      ['unlabelled street', 'input#unlabeled-street'],
      ['empty OTP field', 'input#otp-empty'],
      ['CVV field', 'input#cvv'],
    ],
    unredactedFields: [
      ['OTP heading', 'h1#h-otp'],
      ['Aadhaar heading', 'h2#h-aadhaar'],
      ['resend button', 'button#resend'],
    ],
  },
];
