import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';

export interface ProjectGroup {
  name: string;
  children: { name: string; daysAgo: number }[];
}

export function ProjectList({ projects }: { projects: ProjectGroup[] }) {
  const { t, locale } = useTranslation();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    projects.reduce((acc, p) => ({ ...acc, [p.name]: true }), {})
  );

  const toggleGroup = (name: string) => {
    setOpenGroups(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const formatDays = (days: number) => {
    return locale === 'zh-CN' ? `${days}天` : `${days}d`;
  };

  return (
    <div className="flex flex-col gap-1 w-full text-sm">
      <div className="px-3 py-1 text-xs font-semibold text-[var(--sidebar-text)] opacity-70">
        {t('projects')}
      </div>
      {projects.map((project) => (
        <div key={project.name} className="flex flex-col w-full">
          <button
            onClick={() => toggleGroup(project.name)}
            className="flex items-center w-full px-3 py-1.5 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md group"
          >
            {openGroups[project.name] ? (
              <ChevronDown className="w-4 h-4 mr-1 opacity-70" />
            ) : (
              <ChevronRight className="w-4 h-4 mr-1 opacity-70" />
            )}
            <Folder className="w-4 h-4 mr-2 text-[var(--accent)]" />
            <span className="truncate flex-1 text-left">{project.name}</span>
          </button>
          
          {openGroups[project.name] && (
            <div className="flex flex-col w-full pl-8 pr-3">
              {project.children.map((child) => (
                <button
                  key={child.name}
                  className="flex items-center justify-between w-full py-1.5 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md text-sm"
                >
                  <span className="truncate mr-2 border-l border-[var(--border)] pl-2 -ml-2">{child.name}</span>
                  <span className="text-xs opacity-50 whitespace-nowrap">{formatDays(child.daysAgo)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="px-3 py-1 mt-4 text-xs font-semibold text-[var(--sidebar-text)] opacity-70">
        {t('tasks')}
      </div>
      <div className="px-3 py-1.5 text-[var(--sidebar-text)] opacity-50 text-sm">
        {t('noTasks')}
      </div>
    </div>
  );
}
