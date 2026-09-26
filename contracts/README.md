# Contract planning artifacts

These JSON Schema 2020-12 files are implementation-ready contract baselines, not a running API. They deliberately contain no credentials or real client data.

| Schema | Valid fixtures |
| --- | --- |
| [triage-result.schema.json](triage-result.schema.json) | [suggestion](triage-result.example.json), [abstention](triage-abstain.example.json) |
| [memorize-resolution.schema.json](memorize-resolution.schema.json) | [resolved](memorize-resolved.example.json), [insufficient evidence](memorize-unresolved.example.json) |
| [learning-completion.schema.json](learning-completion.schema.json) | [tool completion](learning-completion.example.json) |
| [event-envelope.schema.json](event-envelope.schema.json) | [ticket closure](ticket-closed-event.example.json) |

Implement Ajv 2020 validation with format support, strict mode and coercion/removal disabled. Generate TypeScript types from these schemas, not a second handwritten shape. For provider structured-output APIs, translate only to a verified supported schema subset; the original application validator is authoritative.

Before each triage request, copy the schema and constrain tag/urgency/complexity to the supplied organization's immutable dictionary values; set dictionary_version to a const for that run. `connectivity` in fixtures is illustrative and must be seeded in the test dictionary. IDs shown are opaque example application message/case IDs; production uses the agreed identifier representation.

Before triage validation the host trims tip steps (≤5), cautions (≤3) and missing_information (≤4), drops step case_refs that are not in evidence_memory_ids and strips case IDs from customer_reply; everything else is validated as returned.

Schema validation cannot establish truth, consent, evidence ownership, successful tool execution, actual completeness or memory eligibility. Host-side checks are required as described in documents 07 and 08. A valid completion JSON is accepted only if its receipt belongs to this run and its reported state matches the stored receipt.

The event envelope is a common ID-only transport shape. During P01 add an event-type registry and specific payload validators for each domain event, including ticket.created, ticket.classified, message.from_client, ticket.assigned, message.from_agent, ticket.closed, rating.received, rating.expired and ticket.reopened. Payload reference IDs resolve inside authorized services; they are not downloadable URLs. UI event schemas are separately scoped and must not expose job internals to clients.

Negative fixtures to implement: extra field, missing tip or customer_reply, unknown dictionary code, wrong version, malformed JSON/duplicate keys, out-of-range confidence, empty evidence, forged evidence ID, resolved outcome with null solution, unresolved outcome with nonnull solution, invented receipt and oversized strings. Invalid samples should fail either schema validation or the explicitly identified semantic guard.
