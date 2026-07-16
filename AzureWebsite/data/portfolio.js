module.exports = {
  person: {
    name: 'Gleb Gladyshevskiy',
    headline: 'I build practical AI, automation, and backend systems that work reliably close to the real world.',
    about: 'I enjoy working close to the metal and close to the problem—from hardware-adjacent code to reliable services.',
    closing: 'Let’s build something precise.'
  },
  social: [
    {
      label: 'GitHub',
      url: 'https://github.com/Glebenator'
    },
    {
      label: 'LinkedIn',
      url: 'https://www.linkedin.com/in/glebgladyshevskiy'
    }
  ],
  projects: [
    {
      slug: 'cvkeharness',
      name: 'CvkeHarness',
      summary: 'A provider-agnostic Go CLI for tool-using local LLM workflows, with approvals, target-aware memory, retrieval, and SQLite history.',
      detail: 'The runtime separates planning, execution, and memory curation while keeping operator guidance readable and tool outcomes auditable.',
      technologies: ['Go', 'Ollama', 'SQLite'],
      featured: true,
      actions: {
        github: {
          label: 'View on GitHub',
          url: 'https://github.com/Glebenator/CvkeHarness'
        },
        liveDemo: null,
        download: null,
        tryIt: null
      }
    },
    {
      slug: 'xdbot',
      name: 'xdBot',
      summary: 'A modular Discord automation bot with async services, local and hosted LLM providers, tool integrations, and persistent settings.',
      detail: 'Its cog-based architecture keeps model providers, search and market-data tools, persistence, and runtime services independently maintainable.',
      technologies: ['Python', 'discord.py', 'Docker'],
      featured: false,
      actions: {
        github: {
          label: 'View on GitHub',
          url: 'https://github.com/Glebenator/xdBot'
        },
        liveDemo: null,
        download: null,
        tryIt: null
      }
    },
    {
      slug: 'ytf',
      name: 'ytf',
      summary: 'A Python package and CLI for downloading YouTube audio and clean captions through an interactive TUI or scriptable API.',
      detail: 'It supports configurable output formats, persisted preferences, direct CLI flags, and a small Python integration surface.',
      technologies: ['Python', 'CLI', 'FFmpeg'],
      featured: false,
      actions: {
        github: {
          label: 'View on GitHub',
          url: 'https://github.com/Glebenator/ytf'
        },
        liveDemo: null,
        download: null,
        tryIt: null
      }
    }
  ]
};
