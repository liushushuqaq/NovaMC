import type { ReactElement, SVGProps } from 'react'

export type IconName =
  | 'home'
  | 'stack'
  | 'grid'
  | 'package'
  | 'user'
  | 'gear'
  | 'search'
  | 'plus'
  | 'play'
  | 'folder'
  | 'refresh'
  | 'check'
  | 'chevron'
  | 'trash'
  | 'edit'
  | 'x'
  | 'warning'
  | 'download'
  | 'stop'
  | 'cpu'
  | 'globe'
  | 'palette'
  | 'window'
  | 'info'
  | 'gauge'
  | 'file'
  | 'link'
  | 'copy'
  | 'github'
  | 'msg'
  | 'heart'
  | 'eye'
  | 'award'
  | 'wallet'
  | 'server'
  | 'shield'
  | 'flame'
  | 'pin'
  | 'chart'
  | 'users'
  | 'ban'
  | 'mail'
  | 'spark'
  | 'send'
  | 'upload'
  | 'image'
  | 'lock'
  | 'clock'
  | 'filter'
  | 'code'

const paths: Record<IconName, ReactElement> = {
  home: <path d="M3 8.6 10 3l7 5.6V16a1 1 0 0 1-1 1h-3.6v-4.6H7.6V17H4a1 1 0 0 1-1-1V8.6Z" />,
  stack: (
    <>
      <path d="M10 2.6 16.4 6v7.8L10 17.4 3.6 13.8V6L10 2.6Z" />
      <path d="M3.7 6.2 10 9.7l6.3-3.5M10 9.7v7.6" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.6" />
      <rect x="11" y="3" width="6" height="6" rx="1.6" />
      <rect x="3" y="11" width="6" height="6" rx="1.6" />
      <rect x="11" y="11" width="6" height="6" rx="1.6" />
    </>
  ),
  package: (
    <>
      <path d="M10 3l7 3.5-7 3.5-7-3.5L10 3Z" />
      <path d="M3 10l7 3.5L17 10M3 13.4l7 3.6 7-3.6" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="6.9" r="3.2" />
      <path d="M3.8 17c0-3.1 2.8-4.7 6.2-4.7s6.2 1.6 6.2 4.7" />
    </>
  ),
  gear: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.9v2.3M10 14.8v2.3M2.9 10h2.3M14.8 10h2.3M4.9 4.9l1.7 1.7M13.4 13.4l1.7 1.7M15.1 4.9l-1.7 1.7M6.6 13.4l-1.7 1.7" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.4" />
      <path d="M13.2 13.2 16.5 16.5" />
    </>
  ),
  plus: <path d="M10 4v12M4 10h12" />,
  play: <path d="M6.5 3.6 16 10l-9.5 6.4V3.6Z" />,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.6 2h6.4A1.5 1.5 0 0 1 17 8.5v6A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5v-8Z" />,
  refresh: (
    <>
      <path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" />
      <path d="M16.6 3.6v3.6h-3.6" />
    </>
  ),
  check: <path d="M4 10.5 8 14.5 16 6" />,
  chevron: <path d="M8 5l4.5 5L8 15" />,
  trash: (
    <>
      <path d="M4 6h12M8 6V4.5h4V6M6 6l.8 10.2A1.2 1.2 0 0 0 8 17.4h4a1.2 1.2 0 0 0 1.2-1.2L14 6" />
    </>
  ),
  edit: (
    <>
      <path d="M13.2 3.6 16.4 6.8 7.6 15.6 4 16.4l.8-3.6 8.4-9.2Z" />
    </>
  ),
  x: <path d="M5 5l10 10M15 5 5 15" />,
  warning: (
    <>
      <path d="M10 3.6 17 15.8H3L10 3.6Z" />
      <path d="M10 8.4v3.2" />
      <circle cx="10" cy="13.9" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  download: <path d="M10 3.5v9M6.4 9.2 10 12.8l3.6-3.6M4 16.5h12" />,
  stop: <rect x="5" y="5" width="10" height="10" rx="2" />,
  cpu: (
    <>
      <rect x="6" y="6" width="8" height="8" rx="1.6" />
      <path d="M9 3v3M11 3v3M9 14v3M11 14v3M3 9h3M3 11h3M14 9h3M14 11h3" />
    </>
  ),
  globe: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2.2 2.4 2.2 11.6 0 14M10 3c-2.2 2.4-2.2 11.6 0 14" />
    </>
  ),
  palette: (
    <>
      <path d="M10 3a7 7 0 0 0 0 14h1.1a1.9 1.9 0 0 0 1.3-3.3 1.9 1.9 0 0 1 1.3-3.3H16A1.7 1.7 0 0 0 17.7 8.7 7 7 0 0 0 10 3Z" />
      <circle cx="7.2" cy="9.1" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="6.9" r="1" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="9.3" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="4.5" width="14" height="11" rx="1.8" />
      <path d="M3 8h14" />
      <circle cx="5.4" cy="6.2" r="0.55" fill="currentColor" stroke="none" />
      <circle cx="7.1" cy="6.2" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9.2v4.4" />
      <circle cx="10" cy="6.6" r="0.85" fill="currentColor" stroke="none" />
    </>
  ),
  gauge: (
    <>
      <path d="M3.6 14.4a7 7 0 1 1 12.8 0" />
      <path d="M10 13.6l3.1-4.4" />
      <circle cx="10" cy="14.2" r="1.1" />
    </>
  ),
  file: (
    <>
      <path d="M5 3.4h6l4 3.9v9.3H5V3.4Z" />
      <path d="M11 3.6v3.9h3.8" />
    </>
  ),
  link: (
    <>
      <path d="M8.6 11.4a3.5 3.5 0 0 0 4.9 0l2.1-2.1a3.5 3.5 0 1 0-4.9-4.9L9.4 5.7" />
      <path d="M11.4 8.6a3.5 3.5 0 0 0-4.9 0l-2.1 2.1a3.5 3.5 0 1 0 4.9 4.9l1.3-1.3" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9" height="10" rx="1.6" />
      <path d="M13 7V4.6A1.6 1.6 0 0 0 11.4 3H5.6A1.6 1.6 0 0 0 4 4.6v7.8A1.6 1.6 0 0 0 5.6 14H7" />
    </>
  ),
  github: (
    <path d="M10 2.2c-4.4 0-8 3.6-8 8 0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-.9-2.7-.9-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3-1.9 3.7-3.6 3.9.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4 3.2-1.1 5.5-4.1 5.5-7.6 0-4.4-3.6-8-8-8Z" />
  ),
  msg: <path d="M17 9.6c0 3.2-3.1 5.8-7 5.8-.9 0-1.8-.1-2.6-.4L4 16.4l1.1-2.9A5.4 5.4 0 0 1 3 9.6C3 6.4 6.1 3.8 10 3.8s7 2.6 7 5.8Z" />,
  heart: <path d="M10 16.2s-6.2-3.6-6.2-7.6A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6.2 2.3c0 4-6.2 7.6-6.2 7.6Z" />,
  eye: (
    <>
      <path d="M2.4 10S5.2 5.2 10 5.2 17.6 10 17.6 10 14.8 14.8 10 14.8 2.4 10 2.4 10Z" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  award: (
    <>
      <circle cx="10" cy="7.6" r="4.4" />
      <path d="M7.2 11.4 6.2 17l3.8-1.9 3.8 1.9-1-5.6" />
    </>
  ),
  wallet: (
    <>
      <rect x="2.8" y="5.2" width="14.4" height="10.4" rx="2.4" />
      <path d="M2.8 8.4h14.4" />
      <circle cx="14.2" cy="12" r="1" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="3.6" width="14" height="5" rx="1.8" />
      <rect x="3" y="11.4" width="14" height="5" rx="1.8" />
      <path d="M6 6.1h.01M6 13.9h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M10 2.8 16.2 5v5c0 3.6-2.5 6.2-6.2 7.1C6.3 16.2 3.8 13.6 3.8 10V5L10 2.8Z" />
      <path d="m7.4 9.8 1.9 2 3.5-3.7" />
    </>
  ),
  flame: <path d="M10 17.5c3 0 5-2 5-4.7 0-3.6-3.7-4.7-3.7-7.8 0 0-1.8.6-2.8 2.3-.8-.8-1.2-1.7-1.2-1.7-1.3 1.7-2.3 3.8-2.3 7.2 0 2.7 2 4.7 5 4.7Z" />,
  pin: (
    <>
      <path d="M7.5 2.8h5l-.9 5 2.9 2.9H5.5L8.4 7.8z" />
      <path d="M10 10.7v6.5" />
    </>
  ),
  chart: <path d="M3.5 16.5V8.5M8 16.5V4M12.5 16.5v-5M17 16.5h-14" />,
  users: (
    <>
      <circle cx="7.6" cy="7" r="2.8" />
      <path d="M2.6 16.4c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5" />
      <path d="M13.4 4.5a2.8 2.8 0 0 1 0 5.2M14.6 12.2c1.7.4 2.8 1.8 3.2 4.2" />
    </>
  ),
  ban: (
    <>
      <circle cx="10" cy="10" r="6.6" />
      <path d="M5.4 5.4 14.6 14.6" />
    </>
  ),
  mail: (
    <>
      <rect x="2.8" y="4.6" width="14.4" height="10.8" rx="2" />
      <path d="m3.6 6.2 6.4 4.4 6.4-4.4" />
    </>
  ),
  spark: <path d="M10 3 11.6 7.4 16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3Z" />,
  send: <path d="M17.4 2.8 8.6 11.6M17.4 2.8 12.2 17.4l-3.6-5.8L3 8.6l14.4-5.8Z" />,
  upload: (
    <>
      <path d="M10 13.4V3.6M6.4 7.2 10 3.6l3.6 3.6" />
      <path d="M3.8 12.6v3.8h12.4v-3.8" />
    </>
  ),
  image: (
    <>
      <rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2" />
      <circle cx="7" cy="8" r="1.3" />
      <path d="m3.2 14.4 4.2-4.2 3.8 3.8 2.4-2.4 3.6 3.2" />
    </>
  ),
  lock: (
    <>
      <rect x="3.8" y="8.4" width="12.4" height="8.8" rx="2" />
      <path d="M6.6 8.4V6.4a3.4 3.4 0 0 1 6.8 0v2" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="6.8" />
      <path d="M10 6v4.2l2.8 1.6" />
    </>
  ),
  filter: <path d="M3.4 5.4h13.2M5.8 10h8.4M8.2 14.6h3.6" />,
  code: <path d="M7 6 3 10l4 4M13 6l4 4-4 4M12.5 4.5l-1 11" />
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 16, ...rest }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}
