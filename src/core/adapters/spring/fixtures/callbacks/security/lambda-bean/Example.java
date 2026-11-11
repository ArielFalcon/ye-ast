package app;
import org.springframework.context.annotation.Bean;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.stereotype.Service;
@Service class Users implements UserDetailsService {
  public Object loadUserByUsername(String name) { return null; }
}
class Config {
  Object load(String name) { return null; }
  @Bean UserDetailsService reference() { return this::load; }
  @Bean UserDetailsService lambda() { return name -> other -> other; }
  void unrelated() {
    java.util.stream.Stream.of("x").map(x -> x);
    Runnable action = () -> {};
  }
}
