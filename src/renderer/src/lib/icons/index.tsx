import type { Icon as PhosphorIcon, IconProps as PhosphorIconProps } from '@phosphor-icons/react'
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowElbowLeftIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  ArrowsOutIcon,
  BrainIcon,
  BellIcon,
  BrowsersIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  ChatCircleIcon,
  CircleIcon,
  CircleHalfIcon,
  ColumnsIcon,
  CopyIcon,
  CornersOutIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FlagIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  FileIcon,
  PlugsConnectedIcon,
  FileMagnifyingGlassIcon,
  FileTextIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GearSixIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HouseIcon,
  ImageIcon,
  InfoIcon,
  KeyboardIcon,
  ListChecksIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  MinusIcon,
  MonitorIcon,
  PencilIcon,
  PaperPlaneRightIcon,
  PaperclipIcon,
  PlusIcon,
  PulseIcon,
  RobotIcon,
  ScanIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SpinnerIcon,
  SquareIcon,
  SquaresFourIcon,
  StackIcon,
  StarIcon,
  StopIcon,
  StorefrontIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningIcon,
  WrenchIcon,
  XIcon
} from '@phosphor-icons/react'

export type IconProps = PhosphorIconProps & { size?: number }

const ICONS = {
  send: PaperPlaneRightIcon,
  undo: ArrowCounterClockwiseIcon,
  redo: ArrowClockwiseIcon,
  branch: GitBranchIcon,
  pullRequest: GitPullRequestIcon,
  gitMerge: GitMergeIcon,
  gitCommit: GitCommitIcon,
  gitRebase: ArrowElbowLeftIcon,
  revert: ArrowElbowLeftIcon,
  refresh: ArrowsClockwiseIcon,
  arrowDown: ArrowDownIcon,
  arrowUp: ArrowUpIcon,
  stop: StopIcon,
  folder: FolderIcon,
  folderOpen: FolderOpenIcon,
  search: MagnifyingGlassIcon,
  fileSearch: FileMagnifyingGlassIcon,
  file: FileIcon,
  edit: PencilIcon,
  terminal: TerminalWindowIcon,
  chevron: CaretDownIcon,
  chevronRight: CaretRightIcon,
  close: XIcon,
  check: CheckIcon,
  warning: WarningIcon,
  menu: ListIcon,
  plus: PlusIcon,
  pulse: PulseIcon,
  panels: SquaresFourIcon,
  gear: GearSixIcon,
  bell: BellIcon,
  copy: CopyIcon,
  more: DotsThreeIcon,
  monitor: MonitorIcon,
  sliders: SlidersHorizontalIcon,
  folderPlus: FolderPlusIcon,
  folderMinus: FolderMinusIcon,
  doc: FileTextIcon,
  sidebar: SidebarSimpleIcon,
  minimize: MinusIcon,
  maximize: CornersOutIcon,
  // Diagonal arrows — distinct from the corner-bracket window maximize glyph.
  expand: ArrowsOutIcon,
  columns: ColumnsIcon,
  restore: BrowsersIcon,
  image: ImageIcon,
  memory: BrainIcon,
  trash: TrashIcon,
  paperclip: PaperclipIcon,
  mic: MicrophoneIcon,
  circle: CircleIcon,
  circleHalf: CircleHalfIcon,
  square: SquareIcon,
  loader: SpinnerIcon,
  bot: RobotIcon,
  chat: ChatCircleIcon,
  sparkles: SparkleIcon,
  marketplace: StorefrontIcon,
  star: StarIcon,
  cpu: PlugsConnectedIcon,
  plug: WrenchIcon,
  globe: GlobeIcon,
  info: InfoIcon,
  keyboard: KeyboardIcon,
  listTodo: ListChecksIcon,
  download: DownloadSimpleIcon,
  flag: FlagIcon,
  thumbsUp: ThumbsUpIcon,
  thumbsDown: ThumbsDownIcon,
  stack: StackIcon,
  folderSearch: MagnifyingGlassIcon,
  scanSearch: ScanIcon,
  home: HouseIcon
} as const satisfies Record<string, PhosphorIcon>

export type IconName = keyof typeof ICONS

/**
 * Narrow a stored string to a real icon key.
 *
 * Persisted fields hold free text — `AgentProfile.avatar` is `z.string().max(32)`,
 * so a roster written by an older build, hand-edited, or synced from another
 * machine can name an icon this build does not have. Rendering that straight
 * into `ICONS[name]` yields `undefined` and crashes the row, so callers test
 * first and fall back.
 */
export function isIconName(value: string | null | undefined): value is IconName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ICONS, value)
}

export function Icon({
  name,
  size = 24,
  weight = 'bold',
  className,
  ...props
}: IconProps & { name: IconName }) {
  const Cmp = ICONS[name]
  return (
    <Cmp
      size={size}
      weight={weight}
      aria-hidden="true"
      focusable="false"
      className={['inline-block shrink-0 align-middle', className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
