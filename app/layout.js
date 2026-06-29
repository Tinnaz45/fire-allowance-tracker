import './globals.css'
import { ProfileProvider } from '@/lib/profile/ProfileContext'
import { ClaimsProvider } from '@/lib/claims/ClaimsContext'
import { RatesProvider } from '@/lib/calculations/RatesContext'
import { FinancialYearProvider } from '@/lib/fy/FinancialYearContext'

export const metadata = {
  title: 'Fire Allowance Tracker',
  description: 'Track recall, retain, standby, and meal claims.',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'FireTracker',
  },
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
  },
  themeColor: '#b30000',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="FireTracker" />
        <meta name="theme-color" content="#b30000" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <ProfileProvider>
          <RatesProvider>
            <FinancialYearProvider>
              <ClaimsProvider>{children}</ClaimsProvider>
            </FinancialYearProvider>
          </RatesProvider>
        </ProfileProvider>
      </body>
    </html>
  )
}
