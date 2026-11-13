package app;

/** Statements before super(...), which the grammar does not accept: a constructor body unread. */
public class StatementsBeforeSuper extends Base {
  public StatementsBeforeSuper(int x) {
    int y = x + 1; // señal
    super(y);
  }

  public void run() { work(); }
}
