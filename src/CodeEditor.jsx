// Editor de código con resaltado (react-syntax-highlighter). Cargado de forma diferida (lazy)
// desde App.jsx, así su peso solo entra al bundle cuando se usa (paso Export → "Header height script").
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import prismJs from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import prismMarkup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import prismCss from "react-syntax-highlighter/dist/esm/languages/prism/css";
import prismTheme from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";

// Snippet bank-ready: registramos solo los lenguajes que usamos (bundle lean).
SyntaxHighlighter.registerLanguage("javascript", prismJs);
SyntaxHighlighter.registerLanguage("markup", prismMarkup);
SyntaxHighlighter.registerLanguage("css", prismCss);

export default function CodeEditor({ code, name, language = "markup" }) {
  return (
    <div className="ds-editor">
      <div className="ds-editor-bar">
        <span className="dot" style={{ background: "#f7544f" }} /><span className="dot" style={{ background: "#f9b94e" }} /><span className="dot" style={{ background: "#54c93f" }} />
        <span className="ds-editor-name">{name}</span>
      </div>
      <SyntaxHighlighter language={language} style={prismTheme} showLineNumbers
        customStyle={{ margin: 0, background: "transparent", padding: "12px 14px", fontSize: 11.5, lineHeight: 1.6 }}
        codeTagProps={{ style: { fontFamily: "'SF Mono',Consolas,monospace", fontSize: 11.5 } }}
        lineNumberStyle={{ minWidth: "2.2em", paddingRight: "1em", color: "#52525b", opacity: 0.8 }}>
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
