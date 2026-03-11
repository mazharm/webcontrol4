import { useEffect, useRef } from "react";
import { Chart, BarController, BarElement, LinearScale, CategoryScale, Tooltip, Legend } from "chart.js";

Chart.register(BarController, BarElement, LinearScale, CategoryScale, Tooltip, Legend);

import type { HistoryPoint } from "../../types/api";

interface FloorActivityChartProps {
  data: HistoryPoint[];
}

export function FloorActivityChart({ data }: FloorActivityChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();

    const labels = data.map((p) => new Date(p.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    chartRef.current = new Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Lights On",
          data: data.map((p) => p.onCount ?? 0),
          backgroundColor: "rgba(59,130,246,0.6)",
        }],
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
