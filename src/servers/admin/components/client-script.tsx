import JS from "./client-script.raw.js";

export function ClientScript() {
  // dangerouslySetInnerHTML is required here: JSX would escape < > & inside
  // a <script> text child, breaking the JavaScript at runtime.
  return <script dangerouslySetInnerHTML={{ __html: JS }} />;
}
