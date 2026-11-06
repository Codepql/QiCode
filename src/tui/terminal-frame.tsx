import { Box, useBoxMetrics, type DOMElement } from "ink";
import { useRef, type ReactNode } from "react";

/** Let Yoga allocate the actual remaining chat height after dynamic controls. */
export function TerminalFrame({ columns, rows, header, footer, children }: {
  columns: number; rows: number; header: ReactNode; footer: ReactNode;
  children(height: number): ReactNode;
}) {
  const region = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(region);
  return <Box flexDirection="column" width={Math.max(1, columns - 1)} height={Math.max(1, rows - 1)} overflow="hidden">
    <Box flexDirection="column" flexShrink={0}>{header}</Box>
    <Box ref={region} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      {children(Math.max(1, metrics.height))}
    </Box>
    <Box flexDirection="column" flexShrink={0}>{footer}</Box>
  </Box>;
}
