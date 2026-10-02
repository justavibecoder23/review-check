// Used only by the dedicated test command. Count SDK calls even if caller
// catches an error before any network request is sent.
const source = `
globalThis.__blogBlobCalls = globalThis.__blogBlobCalls || [];
const stub = name => (...args) => {
  globalThis.__blogBlobCalls.push(name);
  throw new Error('BLOB_FORBIDDEN_IN_PREVIEW_TEST');
};
export const put=stub('put'),get=stub('get'),head=stub('head'),list=stub('list'),del=stub('del'),copy=stub('copy');
`;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') return { url:'data:text/javascript,' + encodeURIComponent(source), shortCircuit:true };
  return nextResolve(specifier, context);
}
