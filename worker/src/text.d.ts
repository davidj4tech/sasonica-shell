// Text modules (wrangler's rules): schema.sql comes in as a string.
declare module '*.sql' {
  const text: string
  export default text
}
