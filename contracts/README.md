# Contract usage

brain.schema.json is a versioned JSON Schema draft 2020-12 for portable core objects. It is a starting contract, not a complete database schema or HTTP OpenAPI document.

The fixture conforms to the root schema. Individual definitions can be used for model output components and API validation. Generate or share runtime schemas rather than allowing multiple incompatible definitions.

The standard-library build-pack validator covers the exact keywords used here, not the entire JSON Schema standard. Use a production-grade runtime validator in the application.

Authorization, cross-project consistency, citation substring checks, revision transitions, budget admission, and deletion require domain validation beyond structural JSON Schema.

Source offsets use Unicode code points, not UTF-16 code units. Evidence end offsets are exclusive.

Before changing a contract, increment its format version when compatibility breaks, update fixtures and migration/import logic, and add a compatibility test.
