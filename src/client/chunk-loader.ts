/**
 * 插件自身的 package-local 动态 chunk 加载器。
 *
 * DSH 的客户端模块加载器把 `require.async('./client.<name>.js')` 解析为
 * `/plugins/<包名>/client.<name>.js?rev=...`，只在真正调用时下载。这里的
 * `require` 是模块 factory 的参数，不是 Node 的全局 require。
 */
declare const require: { async(specifier: string): Promise<unknown> }

/**
 * 懒加载一个插件内 chunk。
 * @param specifier 相对 chunk 文件名，例如 `./client.mermaid.js`。
 * @returns chunk 的 module.exports。
 */
export function loadClientChunk<T>(specifier: string): Promise<T> {
  return require.async(specifier) as Promise<T>
}
