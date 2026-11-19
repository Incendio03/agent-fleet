import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/**
 * Renders an assistant reply (GitHub-flavored Markdown) safely:
 *  - raw HTML in the text is shown as text, never inserted into the page;
 *  - links open in the system browser (a click must never navigate the app window);
 *  - images are never fetched (a reply could otherwise make the app call any URL):
 *    they are shown as links;
 *  - code blocks get syntax colours and a Copy button.
 */

type HastNode = { type?: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** Plain text inside a syntax tree node (the code as written, without highlighting spans). */
function textOf(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

const openLink = (href: string | undefined): void => {
  if (href && /^(https?:\/\/|mailto:)/i.test(href)) void window.fleet.openExternal(href).catch(() => undefined)
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const code = node?.children?.find((c) => c.tagName === 'code')
  const classes = code?.properties?.className
  const lang = (Array.isArray(classes) ? classes.map(String) : []).find((c) => c.startsWith('language-'))?.slice(9)

  const copy = (): void => {
    void navigator.clipboard.writeText(textOf(code ?? node).replace(/\n$/, '')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang ?? 'text'}</span>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        openLink(href)
      }}
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : undefined
    return (
      <a
        href={url}
        title={url}
        onClick={(e) => {
          e.preventDefault()
          openLink(url)
        }}
      >
        {alt || 'image'} ↗
      </a>
    )
  },
  pre: ({ node, children }: JSX.IntrinsicElements['pre'] & ExtraProps) => (
    <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>
  ),
  // Wide tables scroll sideways inside the message instead of stretching it.
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  )
}

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeHighlight]

export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
