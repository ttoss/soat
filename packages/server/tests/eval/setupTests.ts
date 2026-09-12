// The eval needs exactly the process-wide environment the unit suite sets up —
// `EMBEDDING_DIMENSIONS` above all, which `@soat/postgresdb` reads at module
// load to size every vector column, and which must match the width the template
// schema was built with.
import '../unit/setupTests';
