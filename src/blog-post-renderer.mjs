// Compatibility entry point for the admin API. Public pages, previews and SEO
// artifacts intentionally share one renderer and one content model.
export {
  buildBlogSchemas,
  createBlogSchemas,
  renderBlogBody,
  renderBlogIndexTemplate,
  renderBlogPreview,
  renderBlogPost
} from './blog-renderer.mjs';
