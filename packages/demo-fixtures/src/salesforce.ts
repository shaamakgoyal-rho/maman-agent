/**
 * Deterministic Salesforce demo world (spec §24 expected shadow diff):
 * - ten input CSV rows
 * - seven confident matches
 * - two ambiguous rows skipped
 * - one missing account
 * - four proposed field changes across three accounts
 */

export type CsvAccountRow = {
  company: string;
  domain: string;
  owner: string;
  employee_count: number;
  website: string;
  segment: string;
};

export type SfAccount = {
  id: string;
  name: string;
  domain: string;
  owner: string;
  employee_count: number;
  website: string;
  segment: string;
};

/** The account list the user exports from their spreadsheet. */
export const DEMO_CSV_ROWS: CsvAccountRow[] = [
  {
    company: "Northwind Traders",
    domain: "northwind.example",
    owner: "Alex",
    employee_count: 250,
    website: "https://northwind.example",
    segment: "Mid-Market",
  },
  {
    company: "Initech",
    domain: "initech.example",
    owner: "Alex",
    employee_count: 1200,
    website: "https://initech.example",
    segment: "Enterprise",
  },
  {
    company: "Globex",
    domain: "globex.example",
    owner: "Sam",
    employee_count: 5000,
    website: "https://globex.example",
    segment: "Enterprise",
  },
  {
    company: "Umbrella Health",
    domain: "umbrella.example",
    owner: "Alex",
    employee_count: 90,
    website: "https://umbrella.example",
    segment: "SMB",
  },
  {
    company: "Stark Industries",
    domain: "stark.example",
    owner: "Riley",
    employee_count: 9000,
    website: "https://stark.example",
    segment: "Enterprise",
  },
  {
    company: "Wayne Enterprises",
    domain: "wayne.example",
    owner: "Alex",
    employee_count: 7000,
    website: "https://wayne.example",
    segment: "Enterprise",
  },
  {
    company: "Acme Rockets",
    domain: "acme-rockets.example",
    owner: "Sam",
    employee_count: 40,
    website: "https://acme-rockets.example",
    segment: "SMB",
  },
  // Ambiguous pair 1: two SF accounts share this domain (duplicate) → skip.
  {
    company: "Duplicorp",
    domain: "duplicorp.example",
    owner: "Alex",
    employee_count: 300,
    website: "https://duplicorp.example",
    segment: "Mid-Market",
  },
  // Ambiguous pair 2: name mismatch vs SF record on the same domain → skip.
  {
    company: "Renamed Holdings",
    domain: "oldname.example",
    owner: "Riley",
    employee_count: 150,
    website: "https://renamed.example",
    segment: "Mid-Market",
  },
  // Missing: no Salesforce account exists for this domain at all.
  {
    company: "Brand New Startup",
    domain: "brandnew.example",
    owner: "Alex",
    employee_count: 12,
    website: "https://brandnew.example",
    segment: "SMB",
  },
];

/** The Salesforce org the demo connector serves. Deviations are deliberate. */
export const DEMO_SF_ACCOUNTS: SfAccount[] = [
  // 4 field deviations across 3 accounts (Northwind x2, Initech x1, Umbrella x1):
  {
    id: "001DEMO000001",
    name: "Northwind Traders",
    domain: "northwind.example",
    owner: "Jordan",
    employee_count: 180,
    website: "https://northwind.example",
    segment: "Mid-Market",
  },
  {
    id: "001DEMO000002",
    name: "Initech",
    domain: "initech.example",
    owner: "Alex",
    employee_count: 1200,
    website: "https://www.initech.example",
    segment: "Enterprise",
  },
  {
    id: "001DEMO000003",
    name: "Globex",
    domain: "globex.example",
    owner: "Sam",
    employee_count: 5000,
    website: "https://globex.example",
    segment: "Enterprise",
  },
  {
    id: "001DEMO000004",
    name: "Umbrella Health",
    domain: "umbrella.example",
    owner: "Alex",
    employee_count: 90,
    website: "https://umbrella.example",
    segment: "Mid-Market",
  },
  {
    id: "001DEMO000005",
    name: "Stark Industries",
    domain: "stark.example",
    owner: "Riley",
    employee_count: 9000,
    website: "https://stark.example",
    segment: "Enterprise",
  },
  {
    id: "001DEMO000006",
    name: "Wayne Enterprises",
    domain: "wayne.example",
    owner: "Alex",
    employee_count: 7000,
    website: "https://wayne.example",
    segment: "Enterprise",
  },
  {
    id: "001DEMO000007",
    name: "Acme Rockets",
    domain: "acme-rockets.example",
    owner: "Sam",
    employee_count: 40,
    website: "https://acme-rockets.example",
    segment: "SMB",
  },
  // duplicate domain (ambiguous pair 1)
  {
    id: "001DEMO000008",
    name: "Duplicorp",
    domain: "duplicorp.example",
    owner: "Alex",
    employee_count: 300,
    website: "https://duplicorp.example",
    segment: "Mid-Market",
  },
  {
    id: "001DEMO000009",
    name: "Duplicorp Europe",
    domain: "duplicorp.example",
    owner: "Morgan",
    employee_count: 120,
    website: "https://eu.duplicorp.example",
    segment: "Mid-Market",
  },
  // name mismatch on same domain (ambiguous pair 2)
  {
    id: "001DEMO000010",
    name: "Oldname Systems",
    domain: "oldname.example",
    owner: "Riley",
    employee_count: 150,
    website: "https://oldname.example",
    segment: "Mid-Market",
  },
];

export type ProposedFieldChange = {
  account_id: string;
  account_name: string;
  field: "owner" | "employee_count" | "website" | "segment";
  old_value: string;
  new_value: string;
};

/** Fields the reconciliation compares (spec journey: owner, employees, website, segment). */
export const COMPARED_FIELDS = ["owner", "employee_count", "website", "segment"] as const;

/** The exact expected shadow diff — 4 changes across 3 accounts. */
export const EXPECTED_DEMO_CHANGES: ProposedFieldChange[] = [
  {
    account_id: "001DEMO000001",
    account_name: "Northwind Traders",
    field: "owner",
    old_value: "Jordan",
    new_value: "Alex",
  },
  {
    account_id: "001DEMO000001",
    account_name: "Northwind Traders",
    field: "employee_count",
    old_value: "180",
    new_value: "250",
  },
  {
    account_id: "001DEMO000002",
    account_name: "Initech",
    field: "website",
    old_value: "https://www.initech.example",
    new_value: "https://initech.example",
  },
  {
    account_id: "001DEMO000004",
    account_name: "Umbrella Health",
    field: "segment",
    old_value: "Mid-Market",
    new_value: "SMB",
  },
];
