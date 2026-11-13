package app;
import lombok.Data;
@Data
public class Person {
  private String name;
  private final String id = "x";
  private boolean active;
  private boolean isAdmin;
  private Boolean boxed;
  private static int count;
}
