export function ProductArt({ kind }: { kind: string }) {
  if (kind === "headphones")
    return (
      <svg className="art" viewBox="0 0 300 300" fill="none" aria-hidden="true">
        <path
          d="M64 163v-31c0-54 38-94 86-94s86 40 86 94v31"
          stroke="currentColor"
          strokeWidth="22"
          strokeLinecap="round"
        />
        <path
          d="M60 157c-16 0-27 15-27 34v29c0 19 11 34 27 34h22c10 0 17-8 17-18v-61c0-10-7-18-17-18H60Zm180 0c16 0 27 15 27 34v29c0 19-11 34-27 34h-22c-10 0-17-8-17-18v-61c0-10 7-18 17-18h22Z"
          fill="currentColor"
        />
        <path
          d="M78 195v22m144-22v22"
          stroke="#fff"
          strokeWidth="5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === "jacket")
    return (
      <svg className="art" viewBox="0 0 300 300" fill="none" aria-hidden="true">
        <path
          d="m99 47 51 18 51-18 31 27 36 112-38 16-16-32v94H86v-94l-16 32-38-16L68 74l31-27Z"
          fill="currentColor"
        />
        <path
          d="m99 47 51 61 51-61m-51 61v156m-64-94 23 12m105-12-23 12"
          stroke="#fff"
          strokeWidth="6"
        />
        <path
          d="M112 194h23v34h-23m76-34h-23v34h23"
          stroke="#fff"
          strokeWidth="4"
        />
      </svg>
    );
  if (kind === "coffee")
    return (
      <svg className="art" viewBox="0 0 300 300" fill="none" aria-hidden="true">
        <path d="M85 43h130l-15 214H100L85 43Z" fill="currentColor" />
        <path d="M88 74h124M101 209h98" stroke="#fff" strokeWidth="7" />
        <path
          d="M150 122c-27 0-40 17-40 37s15 33 40 33 40-13 40-33-13-37-40-37Z"
          stroke="#fff"
          strokeWidth="5"
        />
        <path d="M159 125c-17 13-25 30-18 64" stroke="#fff" strokeWidth="5" />
      </svg>
    );
  return (
    <svg className="art" viewBox="0 0 300 300" fill="none" aria-hidden="true">
      <rect
        x="47"
        y="80"
        width="206"
        height="145"
        rx="13"
        stroke="currentColor"
        strokeWidth="14"
      />
      <path d="M47 127h206" stroke="currentColor" strokeWidth="13" />
      <circle cx="150" cy="174" r="27" fill="currentColor" />
      <path
        d="M150 52v15m-69-7 8 13m130-13-8 13"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
      />
    </svg>
  );
}
