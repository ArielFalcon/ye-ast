package app;
import lombok.*;
@Getter
@Setter(AccessLevel.PACKAGE)
@ToString(callSuper = true)
public class Wildcarded {
  private String name;
  @Getter(AccessLevel.NONE) private String secret;
}
