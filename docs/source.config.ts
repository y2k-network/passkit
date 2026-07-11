import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: '../src',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// AutoTypeTable (../components/mdx.tsx) is wired as a Server Component
// rather than through remarkAutoTypeTable here — see that file for why.
export default defineConfig({
  mdxOptions: {
    // MDX options
  },
});
