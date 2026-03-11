import { makeStyles, tokens, MessageBar, MessageBarBody } from "@fluentui/react-components";
import { useDevices } from "../../hooks/useDevices";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "12px",
  },
});

export function AlertsBanner() {
  const styles = useStyles();
  const { alerts } = useDevices();

  if (alerts.length === 0) return null;

  return (
    <div className={styles.root}>
      {alerts.map((alert) => (
        <MessageBar key={alert.id} intent="warning" layout="singleline">
          <MessageBarBody>{alert.message}</MessageBarBody>
        </MessageBar>
      ))}
    </div>
  );
}
