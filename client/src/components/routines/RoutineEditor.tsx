import { useEffect, useMemo, useState } from "react";
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
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { Add24Regular, Delete24Regular } from "@fluentui/react-icons";
import type { Routine, RoutineStep } from "../../types/devices";
import { useDevicesByType } from "../../hooks/useDevices";
import { useIsMobile } from "../../hooks/useIsMobile";
import { saveRoutine } from "../../api/routines";

const useStyles = makeStyles({
  surface: {
    width: "fit-content",
    maxWidth: "800px",
    display: "flex",
    flexDirection: "column",
  },
  surfaceMobile: {
    width: "100vw",
    maxWidth: "100vw",
    height: "100dvh",
    maxHeight: "100dvh",
    borderRadius: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    maxHeight: "75vh",
    overflowY: "auto",
    overflowX: "auto",
    padding: "2px", // Prevent focus outline clipping
  },
  helper: {
    color: tokens.colorNeutralForeground3,
  },
  stepCard: {
    padding: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    flexShrink: 0,
    minHeight: "auto",
  },
  stepHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  },
  stepTitle: {
    fontWeight: tokens.fontWeightSemibold,
  },
  stepRow: {
    display: "grid",
    // Reduced min-widths to prevent overflow on smaller screens
    gridTemplateColumns: "minmax(150px, 1fr) minmax(200px, 1.3fr) minmax(120px, 1fr)",
    gap: "12px",
    alignItems: "end",
    "@media (max-width: 1050px)": {
      gridTemplateColumns: "1fr 1fr",
    },
    "@media (max-width: 720px)": {
      gridTemplateColumns: "1fr",
    },
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: "0",
  },
  fieldLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  fullWidthField: {
    width: "100%",
    minWidth: "0",
  },
  deleteButton: {
    alignSelf: "end",
  },
  stepSummary: {
    color: tokens.colorNeutralForeground3,
    overflowWrap: "anywhere",
  },
  scheduleRow:{
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
    flexShrink: 0,
  },
  error: {
    marginBottom: "8px",
  },
});

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const stepTypes: Array<{ value: RoutineStep["type"]; label: string }> = [
  { value: "light_power", label: "Set Light Power" },
  { value: "light_level", label: "Set Light Level" },
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

function normalizeStep(step: RoutineStep): RoutineStep {
  return step.type === "light_toggle" ? { ...step, type: "light_power" } : step;
}

function getDefaultStep(
  type: RoutineStep["type"],
  lights: ReturnType<typeof useDevicesByType>,
  thermostats: ReturnType<typeof useDevicesByType>,
  preferredDeviceId?: number,
): RoutineStep | null {
  const lightType = type === "light_level" || type === "light_power" || type === "light_toggle";
  const pool = lightType ? lights : thermostats;
  const preferred = pool.find((device) => Number(device.id.replace("control4:", "")) === preferredDeviceId);
  const device = preferred || pool[0];
  if (!device) return null;

  const base: RoutineStep = {
    type: type === "light_toggle" ? "light_power" : type,
    deviceId: Number(device.id.replace("control4:", "")),
    deviceName: device.name,
  };

  switch (type) {
    case "light_level":
      return { ...base, type: "light_level", level: 100 };
    case "light_power":
    case "light_toggle":
      return { ...base, type: "light_power", on: true };
    case "hvac_mode":
      return { ...base, type: "hvac_mode", mode: "Auto" };
    case "heat_setpoint":
      return { ...base, type: "heat_setpoint", value: 68 };
    case "cool_setpoint":
      return { ...base, type: "cool_setpoint", value: 74 };
    default:
      return base;
  }
}

function getStepSummary(step: RoutineStep): string {
  switch (step.type) {
    case "light_power":
    case "light_toggle":
      return `${step.deviceName}: turn ${step.on ? "on" : "off"}`;
    case "light_level":
      return `${step.deviceName}: set light level to ${step.level ?? 0}%`;
    case "hvac_mode":
      return `${step.deviceName}: set HVAC mode to ${step.mode ?? "Auto"}`;
    case "heat_setpoint":
      return `${step.deviceName}: set heat to ${step.value ?? 68}F`;
    case "cool_setpoint":
      return `${step.deviceName}: set cool to ${step.value ?? 74}F`;
    default:
      return step.deviceName;
  }
}

export function RoutineEditor({ routine, open, onClose, onSaved }: RoutineEditorProps) {
  const styles = useStyles();
  const { isMobile } = useIsMobile();
  const lights = useDevicesByType("light");
  const thermostats = useDevicesByType("thermostat");

  const [name, setName] = useState("");
  const [steps, setSteps] = useState<RoutineStep[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("08:00");
  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(routine?.name || "");
    setSteps((routine?.steps || []).map((step) => normalizeStep(step)));
    setScheduleEnabled(routine?.schedule?.enabled || false);
    setScheduleTime(routine?.schedule?.time || "08:00");
    setScheduleDays(routine?.schedule?.days || [1, 2, 3, 4, 5]);
    setError(null);
    setSaving(false);
  }, [open, routine]);

  // Sanitize steps before saving to ensure required numbers are present
  const sanitizeStepsForSave = (steps: RoutineStep[]): RoutineStep[] => {
    return steps.map(step => {
      const copy = { ...step };
      if (step.type === "light_level" && step.level === undefined) copy.level = 0;
      if ((step.type === "heat_setpoint" || step.type === "cool_setpoint") && step.value === undefined) copy.value = 70;
      return copy;
    });
  };

  const availableDevicesByStep = useMemo(
    () =>
      steps.map((step) =>
        step.type === "light_level" || step.type === "light_power" || step.type === "light_toggle"
          ? lights
          : thermostats,
      ),
    [lights, steps, thermostats],
  );

  const addStep = () => {
    const defaultType: RoutineStep["type"] = lights.length > 0 ? "light_power" : "hvac_mode";
    const next = getDefaultStep(defaultType, lights, thermostats);
    if (!next) {
      setError("No compatible devices are available for routine steps.");
      return;
    }
    setError(null);
    setSteps((current) => [...current, next]);
  };

  const removeStep = (index: number) => {
    setSteps((current) => current.filter((_, i) => i !== index));
  };

  const updateStep = (index: number, updates: Partial<RoutineStep>) => {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...updates } : step)));
  };

  const changeStepType = (index: number, type: RoutineStep["type"]) => {
    const current = steps[index];
    const next = getDefaultStep(type, lights, thermostats, current?.deviceId);
    if (!next) {
      setError(`No compatible devices are available for ${type.replace("_", " ")}.`);
      return;
    }
    setError(null);
    setSteps((existing) => existing.map((step, i) => (i === index ? next : step)));
  };

  const changeStepDevice = (index: number, deviceId: number) => {
    const current = steps[index];
    if (!current) return;
    const next = getDefaultStep(current.type, lights, thermostats, deviceId);
    if (!next) return;

    const merged: RoutineStep = { ...next };
    if (current.type === next.type) {
      if (current.type === "light_level") merged.level = current.level ?? next.level;
      if (current.type === "light_power" || current.type === "light_toggle") merged.on = current.on ?? next.on;
      if (current.type === "hvac_mode") merged.mode = current.mode ?? next.mode;
      if (current.type === "heat_setpoint" || current.type === "cool_setpoint") {
        merged.value = current.value ?? next.value;
      }
    }
    setSteps((existing) => existing.map((step, i) => (i === index ? merged : step)));
  };

  const toggleDay = (day: number) => {
    setScheduleDays((days) =>
      days.includes(day) ? days.filter((current) => current !== day) : [...days, day].sort(),
    );
  };

  const handleSave = async () => {
    if (!name.trim() || steps.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await saveRoutine({
        id: routine?.id || `r_${Date.now()}`,
        name: name.trim(),
        steps: sanitizeStepsForSave(steps),
        schedule: scheduleEnabled ? { enabled: true, time: scheduleTime, days: scheduleDays } : undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save routine");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface className={isMobile ? styles.surfaceMobile : styles.surface}>
        <DialogTitle>{routine ? "Edit Routine" : "New Routine"}</DialogTitle>
        <DialogBody style={{ display: "flex", flexDirection: "column", overflow: "hidden", marginBottom: "16px" }}>
          <div className={styles.body}>
            {error && (
              <MessageBar intent="error" className={styles.error}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}

            <Input
              value={name}
              onChange={(_, data) => setName(data.value)}
              placeholder="Routine name"
              style={{ width: "100%" }}
            />

            <Text weight="semibold">Steps</Text>

            {steps.map((step, index) => (
              <Card key={index} className={styles.stepCard}>
                <div className={styles.stepHeader}>
                  <Text className={styles.stepTitle}>Step {index + 1}</Text>
                </div>

                <div className={styles.stepRow}>
                  <div className={styles.field}>
                    <Text className={styles.fieldLabel}>Action</Text>
                    <Dropdown
                      value={stepTypes.find((item) => item.value === step.type)?.label || step.type}
                      selectedOptions={[step.type]}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) changeStepType(index, data.optionValue as RoutineStep["type"]);
                      }}
                      className={styles.fullWidthField}
                      listbox={{ style: { maxHeight: "60vh", overflowY: "auto" } }}
                      positioning={{ autoSize: "height" }}
                    >
                      {stepTypes.map((item) => (
                        <Option
                          key={item.value}
                          value={item.value}
                          text={item.label}
                        >
                          {item.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>

                  <div className={styles.field}>
                    <Text className={styles.fieldLabel}>Device</Text>
                    <Dropdown
                      value={step.deviceName}
                      selectedOptions={[String(step.deviceId)]}
                      onOptionSelect={(_, data) => {
                        if (!data.optionValue) return;
                        changeStepDevice(index, parseInt(data.optionValue, 10));
                      }}
                      className={styles.fullWidthField}
                      listbox={{ style: { maxHeight: "60vh", overflowY: "auto" } }}
                      positioning={{ autoSize: "height" }}
                    >
                      {availableDevicesByStep[index].map((device) => {
                        const deviceId = device.id.replace("control4:", "");
                        return (
                          <Option
                            key={deviceId}
                            value={deviceId}
                            text={device.name}
                          >
                            {device.name}
                          </Option>
                        );
                      })}
                    </Dropdown>
                  </div>

                  {(step.type === "light_power" || step.type === "light_toggle") && (
                    <div className={styles.field}>
                      <Text className={styles.fieldLabel}>Power</Text>
                      <Dropdown
                        value={step.on ? "Turn On" : "Turn Off"}
                        selectedOptions={[step.on ? "on" : "off"]}
                        onOptionSelect={(_, data) => updateStep(index, { on: data.optionValue === "on" })}
                        className={styles.fullWidthField}
                        listbox={{ style: { maxHeight: "60vh", overflowY: "auto" } }}
                        positioning={{ autoSize: "height" }}
                      >
                        <Option value="on" text="Turn On">Turn On</Option>
                        <Option value="off" text="Turn Off">Turn Off</Option>
                      </Dropdown>
                    </div>
                  )}

                  {(step.type === "light_level" || step.type === "heat_setpoint" || step.type === "cool_setpoint") && (
                    <div className={styles.field}>
                      <Text className={styles.fieldLabel}>
                        {step.type === "light_level" ? "Level (0-100)" : "Temperature (32-120 F)"}
                      </Text>
                      <Input
                        type="number"
                        // Handle undefined values as empty string to allow clearing the input
                        value={step.type === "light_level" 
                          ? (step.level === undefined ? "" : String(step.level))
                          : (step.value === undefined ? "" : String(step.value))
                        }
                        onChange={(_, data) => {
                          const val = data.value === "" ? undefined : parseInt(data.value, 10);
                          if (step.type === "light_level") updateStep(index, { level: val });
                          else updateStep(index, { value: val });
                        }}
                        className={styles.fullWidthField}
                      />
                    </div>
                  )}

                  {step.type === "hvac_mode" && (
                    <div className={styles.field}>
                      <Text className={styles.fieldLabel}>HVAC Mode</Text>
                      <Dropdown
                        value={step.mode || "Auto"}
                        selectedOptions={[step.mode || "Auto"]}
                        onOptionSelect={(_, data) => updateStep(index, { mode: (data.optionValue || "Auto") as RoutineStep["mode"] })}
                        className={styles.fullWidthField}
                        listbox={{ style: { maxHeight: "60vh", overflowY: "auto" } }}
                        positioning={{ autoSize: "height" }}
                      >
                        {(["Off", "Heat", "Cool", "Auto"] as const).map((mode) => (
                          <Option key={mode} value={mode} text={mode}>
                            {mode}
                          </Option>
                        ))}
                      </Dropdown>
                    </div>
                  )}

                  <div className={styles.deleteButton} />
                </div>
                
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                   <Text className={styles.stepSummary}>{getStepSummary(step)}</Text>
                   <Button appearance="subtle" size="small" onClick={() => removeStep(index)}>Remove Step</Button>
                </div>
              </Card>
            ))}

            <Button icon={<Add24Regular />} appearance="outline" onClick={addStep} style={{ flexShrink: 0 }}>
              Add Step
            </Button>

            <div className={styles.section}>
              <Switch
                label="Schedule"
                checked={scheduleEnabled}
                onChange={(_, data) => setScheduleEnabled(data.checked)}
              />
              {scheduleEnabled && (
                <div className={styles.scheduleRow}>
                  <Input
                    type="time"
                    value={scheduleTime}
                    onChange={(_, data) => setScheduleTime(data.value)}
                    style={{ width: "120px" }}
                  />
                  {dayNames.map((day, index) => (
                    <Button
                      key={day}
                      size="small"
                      className={styles.dayButton}
                      appearance={scheduleDays.includes(index) ? "primary" : "outline"}
                      onClick={() => toggleDay(index)}
                    >
                      {day}
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
