export type TriageResult = {
  schema_version: '1.0';
  dictionary_version: string;
  tags: { tag: string; urgency: string; complexity: string };
  suggested_solution: string | null;
  evidence_message_ids: string[];
  evidence_memory_ids: string[];
  missing_information: string[];
  confidence: number;
  needs_review: boolean;
};
export type Resolution = {
  schema_version: '1.0';
  problem_summary: string;
  solution_summary: string | null;
  outcome: 'resolved' | 'unresolved' | 'insufficient_evidence';
  steps: { action: string; evidence_message_ids: string[] }[];
  observed_result: string | null;
  evidence_message_ids: string[];
  applicability: string[];
  cautions: string[];
  uncertainties: string[];
};
export type SnapshotEntry = {
  id: string;
  seq: number;
  role: string;
  text: string;
  delivery: string;
  revision: number;
  attachments: { id: string; status: string; extraction: string | null; coverage: string }[];
  revisions: { revision: number; text: string; deleted: boolean }[];
};
