import { ExternalLink } from 'lucide-react';
import { UmaModal } from './UmaModal.tsx';

interface BugReportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="w-6 h-6 fill-current">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
    </svg>
  );
}

function XMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="w-5 h-5 fill-current">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z" />
    </svg>
  );
}

const REPORT_OPTIONS = [
  {
    id: 'github',
    name: 'GitHub Issues',
    sub: '新規 Issue を作成',
    url: 'https://github.com/miyabitti256/uma-skill-dp-web/issues/new',
    icon: GitHubMark,
  },
  {
    id: 'x',
    name: 'X',
    sub: '@wister_fujicco',
    url: 'https://x.com/wister_fujicco',
    icon: XMark,
  },
] as const;

/**
 * バグ報告先（GitHub Issues / X）を選択する専用モーダル。
 */
export function BugReportModal({ isOpen, onClose }: BugReportModalProps) {
  return (
    <UmaModal
      isOpen={isOpen}
      onClose={onClose}
      title="バグ報告"
      titleId="bug-report-modal-title"
      maxWidthClass="max-w-sm"
    >
      <p className="text-center font-bold text-[#5b4333]">報告方法を選択してください</p>

      <div className="grid grid-cols-2 gap-2.5">
        {REPORT_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          return (
            <a
              key={opt.id}
              href={opt.url}
              target="_blank"
              rel="noopener noreferrer"
              className="uma-btn px-3 py-3.5 flex flex-col items-center justify-center gap-1.5 text-center hover:border-[#76c30f] hover:bg-[#f1fbe8] group"
            >
              <span className="w-10 h-10 rounded-full bg-white border border-[#d6d3dc] group-hover:border-[#76c30f] flex items-center justify-center text-[#5b4333] shadow-xs">
                <Icon />
              </span>
              <span className="font-extrabold text-[13px] text-[#5b4333] inline-flex items-center gap-1">
                {opt.name}
                <ExternalLink className="w-3 h-3 text-[#7a6858]" />
              </span>
              <span className="text-[11px] font-medium text-[#7a6858]">{opt.sub}</span>
            </a>
          );
        })}
      </div>
    </UmaModal>
  );
}
