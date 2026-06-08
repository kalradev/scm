export const ROLES = ['sales', 'finance', 'scm', 'admin'] as const

export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  sales: 'Sales',
  finance: 'Finance',
  scm: 'SCM',
  admin: 'Admin',
}

export function roleHomePath(role: Role): string {
  switch (role) {
    case 'sales':
      return '/sales'
    case 'finance':
      return '/finance'
    case 'scm':
      return '/scm'
    case 'admin':
      return '/admin'
  }
}
