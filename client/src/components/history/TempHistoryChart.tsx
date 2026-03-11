import { useEffect, useRef } from "react";
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend } from "chart.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend);

import type { HistoryPoint } from "../../types/api";

interface TempHistoryChartProps {
  data: HistoryPoint[];
}

export function TempHistoryChart({ data }: TempHistoryChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();

    const labels = data.map((p) => new Date(p.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Current °F",
            data: data.map((p) => p.tempF ?? null),
            borderColor: "#3b82f6",
            tension: 0.3,
          },
          {
            label: "Heat Setpoint",
            data: data.map((p) => p.heatF ?? null),
            borderColor: "#ef4444",
            borderDash: [5, 3],
            tension: 0.3,
          },
          {
            label: "Cool Setpoint",
            data: data.map((p) => p.coolF ?? null),
            borderColor: "#06b6d4",
            borderDash: [5, 3],
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { title: { display: true, text: "°F" } },
        },
      },
    });

    return () => { chartRef.current?.destroy(); };
  }, [data]);

  return <div style={{ height: "300px" }}><canvas ref={canvasRef} /></div>;
}
