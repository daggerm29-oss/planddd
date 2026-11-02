export const metadata = {
  title: "Worldview",
  description: "Real-time tactical geospatial intelligence tracking global aircraft, satellite overwatch, and maritime radar.",
  openGraph: {
    title: "Worldview",
    description: "Real-time tactical geospatial intelligence tracking global aircraft, satellite overwatch, and maritime radar.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
