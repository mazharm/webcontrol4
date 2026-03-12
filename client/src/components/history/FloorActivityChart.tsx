import { useEffect, useRef } from "react";
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend } from "chart.js";
import type { FloorHistorySeries } from "../../types/api";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend);

interface FloorActivityChartProps {
  data: FloorHistorySeries[];
}

export function FloorActivityChart({ data }: FloorActivityChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();

    const palette = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];
    const timestamps = Array.from(
      new Set(data.flatMap((series) => series.points.map((point) => point.ts))),
    ).sort((a, b) => a - b);
    const labels = timestamps.map((ts) =>
      new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels,
        datasets: data.map((series, index) => {
          const pointsByTimestamp = new Map(series.points.map((point) => [point.ts, point.onCount ?? 0]));
          const color = palette[index % palette.length];
          return {
            label: series.floor,
            data: timestamps.map((ts) => pointsByTimestamp.get(ts) ?? null),
            borderColor: color,
            backgroundColor: `${color}33`,
            tension: 0.3,
            spanGaps: true,
            pointRadius: 2,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, title: { display: true, text: "Count" } },
        },
      },
    });

    return () => { chartRef.current?.destroy(); };
  }, [data]);

  return <div style={{ height: "300px" }}><canvas ref={canvasRef} /></div>;
}
