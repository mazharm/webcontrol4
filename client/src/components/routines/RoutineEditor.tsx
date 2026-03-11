import { useState } from "react";
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  Button,
  Input,
  Dropdown,
  Option,
  Switch,
  Text,
  Card,
} from "@fluentui/react-components";
import { Add24Regular, Delete24Regular } from "@fluentui/react-icons";
import type { Routine, RoutineStep } from "../../types/devices";
import { useDevicesByType } from "../../hooks/useDevices";
import { saveRoutine } from "../../api/routines";

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    maxHeight: "60vh",
    overflowY: "auto",
  },
  stepCard: {
    padding: "8px",
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap",
  },
  scheduleRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap",
  },
  dayButton: {
    minWidth: "40px",
  },
  section: {
    marginTop: "8px",
    paddingTop: "8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
  },
});

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const stepTypes: { value: RoutineStep["type"]; label: string }[] = [
  { value: "light_level", label: "Set Light Level" },
  { value: "light_toggle", label: "Toggle Light" },
  { value: "hvac_mode", label: "HVAC Mode" },
  { value: "heat_setpoint", label: "Heat Setpoint" },
  { value: "cool_setpoint", label: "Cool Setpoint" },
];

interface RoutineEditorProps {
  routine: Routine | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function RoutineEditor({ routine, open, onClose, onSaved }: RoutineEditorProps) {
  const styles = useStyles();
  const lights = useDevicesByType("light");
  const thermostats = useDevicesByType("thermostat");

  const [name, setName] = useState(routine?.name || "");
  const [steps, setSteps] = useState<RoutineStep[]>(routine?.steps || []);
  const [scheduleEnabled, setScheduleEnabled] = useState(routine?.schedule?.enabled || false);
  const [scheduleTime, setScheduleTime] = useState(routine?.schedule?.time || "08:00");
  const [scheduleDays, setScheduleDays] = useState<number[]>(routine?.schedule?.days || [1, 2, 3, 4, 5]);
  const [saving, setSaving] = useState(false);

  const allDevices = [...lights, ...thermostats];

  const addStep = () => {
    if (allDevices.length === 0) return;
    const d = allDevices[0];
    const c4Id = parseInt(d.id.replace("control4:", ""));
    setSteps([...steps, {
      type: d.type === "light" ? "light_level" : "hvac_mode",
      deviceId: c4Id,
      deviceName: d.name,
      level: 100,
    }]);
  };

  const removeStep = (idx: number) => {
    setSteps(steps.filter((_, i) => i !== idx));
  };

  const updateStep = (idx: number, updates: Partial<RoutineStep>) => {
    setSteps(steps.map((s, i) => i === idx ? { ...s, ...updates } : s));
  };

  const toggleDay = (day: number) => {
    setScheduleDays((d) =>
      d.includes(day) ? d.filter((dd) => dd !== day) : [...d, day].sort()
    );
  };

  const handleSave = async () => {
    if (!name.trim() || steps.length === 0) return;
    setSaving(true);
    try {
      const r: Routine = {
        id: routine?.id || `r_${Date.now()}`,
        name: name.trim(),
        steps,
        schedule: scheduleEnabled ? { enabled: true, time: scheduleTime, days: scheduleDays } : undefined,
      };
      await saveRoutine(r);
      onSaved();
      onClose();
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogTitle>{routine ? "Edit Routine" : "New Routine"}</DialogTitle>
        <DialogBody>
          <div className={styles.body}>
            <Input
              value={name}
              onChange={(_, d) => setName(d.value)}
              placeholder="Routine name"
              style={{ width: "100%" }}
            />
            <Text weight="semibold">Steps</Text>
            {steps.map((step, idx) => (
              <Card key={idx} className={styles.stepCard}>
                <Dropdown
                  value={stepTypes.find((t) => t.value === step.type)?.label || step.type}
                  selectedOptions={[step.type]}
                  onOptionSelect={(_, d) => d.optionValue && updateStep(idx, { type: d.optionValue as RoutineStep["type"] })}
                  style={{ minWidth: "140px" }}
                >
                  {stepTypes.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                </Dropdown>
                <Dropdown
                  value={step.deviceName}
                  selectedOptions={[String(step.deviceId)]}
                  onOptionSelect={(_, d) => {
                    if (!d.optionValue) return;
                    const dev = allDevices.find((dd) => dd.id.replace("control4:", "") === d.optionValue);
                    if (dev) updateStep(idx, { deviceId: parseInt(d.optionValue), deviceName: dev.name });
                  }}
                  style={{ minWidth: "140px" }}
                >
                  {allDevices.map((d) => {
                    const id = d.id.replace("control4:", "");
                    return <Option key={id} value={id}>{d.name}</Option>;
                  })}
                </Dropdown>
                {(step.type === "light_level" || step.type === "heat_setpoint" || step.type === "cool_setpoint") && (
                  <Input
                    type="number"
                    value={String(step.level ?? step.value ?? 0)}
                    onChange={(_, d) => {
                      const v = parseInt(d.value) || 0;
                      if (step.type === "light_level") updateStep(idx, { level: v });
                      else updateStep(idx, { value: v });
                    }}
                    style={{ width: "70px" }}
                  />
                )}
                <Button icon={<Delete24Regular />} size="small" appearance="subtle" onClick={() => removeStep(idx)} />
              </Card>
            ))}
            <Button icon={<Add24Regular />} appearance="outline" onClick={addStep}>Add Step</Button>

            <div className={styles.section}>
              <Switch
                label="Schedule"
                checked={scheduleEnabled}
                onChange={(_, d) => setScheduleEnabled(d.checked)}
              />
              {scheduleEnabled && (
                <div className={styles.scheduleRow}>
                  <Input
                    type="time"
                    value={scheduleTime}
                    onChange={(_, d) => setScheduleTime(d.value)}
                    style={{ width: "120px" }}
                  />
                  {dayNames.map((d, i) => (
                    <Button
                      key={i}
                      size="small"
                      className={styles.dayButton}
                      appearance={scheduleDays.includes(i) ? "primary" : "outline"}
                      onClick={() => toggleDay(i)}
                    >
                      {d}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogActions>
          <Button appearance="secondary" onClick={onClose}>Cancel</Button>
          <Button appearance="primary" onClick={handleSave} disabled={saving || !name.trim() || steps.length === 0}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </DialogSurface>
    </Dialog>
  );
}
