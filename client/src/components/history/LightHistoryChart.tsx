import { useEffect, useRef } from "react";
import { Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, CategoryScale, Tooltip, Legend, Filler } from "chart.js";
import type { HistoryPoint } from "../../types/api";

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, CategoryScale, Tooltip, Legend, Filler);

interface LightHistoryChartProps {
  data: HistoryPoint[];
}

export function LightHistoryChart({ data }: LightHistoryChartProps) {
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
        datasets: [{
          label: "Light Level %",
          data: data.map((p) => p.level ?? 0),
          borderColor: "#eab308",
          backgroundColor: "rgba(234,179,8,0.1)",
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100, title: { display: true, text: "Level %" } },
        },
        plugins: { legend: { display: false } },
      },
    });

    return () => { chartRef.current?.destroy(); };
  }, [data]);

  return <div style={{ height: "300px" }}><canvas ref={canvasRef} /></div>;
}
