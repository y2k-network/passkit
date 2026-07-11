import defaultMdxComponents from 'fumadocs-ui/mdx';
import { createFileSystemGeneratorCache, createGenerator } from 'fumadocs-typescript';
import { AutoTypeTable, type AutoTypeTableProps } from 'fumadocs-typescript/ui';
import type { MDXComponents } from 'mdx/types';

// Server Component only — extracts type tables straight from ../src/*.ts at
// request/build time. Cached to disk so serverless builds don't re-run tsc
// per request.
const typeTableGenerator = createGenerator({
  cache: createFileSystemGeneratorCache('.next/fumadocs-typescript'),
});

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    AutoTypeTable: (props: Partial<AutoTypeTableProps>) => (
      <AutoTypeTable {...props} generator={typeTableGenerator} />
    ),
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
