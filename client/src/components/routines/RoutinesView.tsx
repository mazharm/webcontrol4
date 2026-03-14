import { useState, useEffect, useCallback } from "react";
import { makeStyles, tokens, Text, Button, Spinner } from "@fluentui/react-components";
import { Add24Regular } from "@fluentui/react-icons";
import { getRoutines } from "../../api/routines";
import { isRemoteMode } from "../../config/transport";
import { getRemoteRoutines } from "../../services/mqtt-rpc";
import { RoutineCard } from "./RoutineCard";
import { RoutineEditor } from "./RoutineEditor";
import type { Routine } from "../../types/devices";

const useStyles = makeStyles({
  root: { maxWidth: "1000px" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "16px",
  },
  title: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    gap: "12px",
  },
  empty: {
    padding: "40px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
});

export function RoutinesView() {
  const styles = useStyles();
  const remote = isRemoteMode();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);

  const fetchRoutines = useCallback(async () => {
    setLoading(true);
    try {
      const data = remote ? await getRemoteRoutines() : await getRoutines();
      setRoutines(data);
    } catch {
      setRoutines([]);
    }
    setLoading(false);
  }, [remote]);

  useEffect(() => { fetchRoutines(); }, [fetchRoutines]);

  const openNew = () => { setEditingRoutine(null); setEditorOpen(true); };
  const openEdit = (r: Routine) => { setEditingRoutine(r); setEditorOpen(true); };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text className={styles.title}>Routines</Text>
        {!remote && <Button icon={<Add24Regular />} appearance="primary" onClick={openNew}>New Routine</Button>}
      </div>
      {loading ? (
        <Spinner label="Loading routines..." />
      ) : routines.length === 0 ? (
        <div className={styles.empty}>No routines yet.</div>
      ) : (
        <div className={styles.grid}>
          {routines.map((r) => (
            <RoutineCard key={r.id} routine={r} onEdit={openEdit} onDeleted={fetchRoutines} remote={remote} />
          ))}
        </div>
      )}
      {!remote && (
        <RoutineEditor
          routine={editingRoutine}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSaved={fetchRoutines}
        />
      )}
    </div>
  );
}
