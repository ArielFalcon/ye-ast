package app;
import external.lib.Thing;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.Setter;
@Getter
@Setter(AccessLevel.PACKAGE)
public class Libbed extends Thing {
  private String title;
}
